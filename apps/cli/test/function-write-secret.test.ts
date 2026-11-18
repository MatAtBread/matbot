import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { buildAsyncFn, runFunction, type CompileHost } from '@matatbread/matbot-function-tools';
import type { MatbotMachine, Message, PermissionRequest, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { VaultImpl, permitted, refused } from '@matatbread/matbot-core';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

// A server may ISSUE a credential, and the body that received it is where it can be stored without the value
// passing through the model: `context.writeSecret`. Pinned here: a create and a replace are different
// gates, a replace remembered by nothing; what is refused before anything is asked; the value is never in
// a prompt; and once written it is redacted from everything the call yields.

const ISSUED = 'as_sk_issued0123456789abcdef';

const runner = createVmFunctionRunner(2000);
const host: CompileHost = { TypeScriptStripper: { strip: (s: string) => stripTypeScriptTypes(s) }, FunctionRunner: runner };

// A tool standing in for a server that hands out a key in its result.
const issuer: Tool = {
  name: 'issuer', description: '', inputSchema: { type: 'object' },
  executor: { async *execute() { yield { type: 'result', value: { text: `Your key: api_key=${ISSUED}` } }; } },
};

function machineWith(withRunner: boolean): MatbotMachine {
  return {
    tools: { list: () => [issuer], resolve: (n: string) => (n === 'issuer' ? issuer : null), register: () => {}, remove: () => false },
    ...(withRunner ? { FunctionRunner: runner } : {}),
  } as unknown as MatbotMachine;
}

type Asked = PermissionRequest & { namespace?: string };

async function run(def: string, opts: { vault?: Record<string, string>; allow?: (req: Asked) => boolean; history?: Message[]; runner?: boolean } = {}):
  Promise<{ events: ToolEvent[]; final: ToolEvent | undefined; asked: Asked[]; vault: VaultImpl }> {
  const asked: Asked[] = [];
  const vault = new VaultImpl(opts.vault ?? {});
  const ctx = {
    callId: 'c1', session: { id: 's1', messages: opts.history ?? [] }, signal: new AbortController().signal, vault,
    prompt: () => Promise.reject(new Error('non-interactive')),
    gate: (req: Asked) => {
      const subject = req.subject.replace(/^probe@[0-9a-f]{32} /, 'probe ');
      const seen = { ...req, subject, ...(req.standing !== undefined ? { standing: req.standing.map(o => ({ ...o, subject: o.subject.replace(/^probe@[0-9a-f]{32} /, 'probe ') })) } : {}) };
      asked.push(seen);
      return Promise.resolve((opts.allow ?? (() => true))(seen) ? permitted('user') : refused('user'));
    },
  } as unknown as ToolContext;
  const machine = machineWith(opts.runner ?? true);
  const fn = await buildAsyncFn(host, def, []);
  const events: ToolEvent[] = [];
  for await (const ev of runFunction(machine, ctx, fn, [], { tool: 'probe', source: def })) events.push(ev);
  return { events, final: events.at(-1), asked, vault };
}

const STORE = `probe() {
  return tool.issuer({}).then(r => {
    const key = /api_key=(\\S+)/.exec(r.text)[1];
    context.progress(50, 'got ' + key);
    return context.writeSecret('ACME_API_KEY', key).then(() => ({ stored: true, echoed: key, nested: [{ k: key }] }));
  });
}`;

for (const withRunner of [true, false]) {
  test(`an issued key is stored after one create question, and redacted from everything the call yields (${withRunner ? 'node runner' : 'no runner'})`, async () => {
    const { events, final, asked, vault } = await run(STORE, { runner: withRunner });
    assert.equal(await vault.readSecret('ACME_API_KEY'), ISSUED);
    assert.deepEqual(final, { type: 'result', value: { stored: true, echoed: '[REDACTED]', nested: [{ k: '[REDACTED]' }] } });
    // The live `← issuer: …` trace of the call that RECEIVED the key is yielded before the body could store
    // it, so it is the one event that still carries it: stdout is live-only (never persisted, never sent to
    // the model). Everything after the write is redacted.
    const after = events.filter(e => !(e.type === 'stdout' && e.chunk.startsWith('← issuer')));
    assert.ok(!JSON.stringify(after).includes(ISSUED), JSON.stringify(after));

    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0]?.namespace, asked[0]?.gate, asked[0]?.subject, asked[0]?.fallback], ['tool_function', 'write-secret', 'probe ACME_API_KEY', false]);
    assert.deepEqual(asked[0]?.standing?.map(s => s.subject), ['probe ACME_API_KEY', '* ACME_API_KEY']);
    assert.match(asked[0]?.label ?? '', new RegExp(`${ISSUED.length}-character`));
    assert.ok(!JSON.stringify(asked).includes(ISSUED), 'a prompt never carries the value');
  });
}

test('a refused create stores nothing, and the body sees why', async () => {
  const { final, vault } = await run(`probe() { return context.writeSecret('ACME_API_KEY', 'v-0123456789abcdef'.split('-').join('')).then(() => 'stored', e => e.message); }`, { allow: () => false });
  assert.equal(vault.hasKey('ACME_API_KEY'), false);
  assert.match(String((final as { value: unknown }).value), /Storing ACME_API_KEY/);
});

test('replacing an existing key is its own gate, remembered by nothing, with its own answers', async () => {
  const { final, asked, vault } = await run(STORE, { vault: { ACME_API_KEY: 'old-key' } });
  assert.equal(final?.type, 'result');
  assert.equal(await vault.readSecret('ACME_API_KEY'), ISSUED);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.gate, 'replace-secret');
  assert.deepEqual(asked[0]?.lifetimes, []);
  assert.deepEqual(asked[0]?.answers, { yes: 'Replace', no: 'Cancel' });
  assert.equal(asked[0]?.standing, undefined);
});

test('a refused replace leaves the old key', async () => {
  const { vault, final } = await run(STORE, { vault: { ACME_API_KEY: 'old-key' }, allow: r => r.gate !== 'replace-secret' });
  assert.equal(final?.type, 'error');
  assert.equal(await vault.readSecret('ACME_API_KEY'), 'old-key');
});

const refusedBeforeAsking: [string, string, RegExp][] = [
  ['an empty value, which would remove the key', `context.writeSecret('ACME_API_KEY', '')`, /empty value/],
  ['a control character', `context.writeSecret('ACME_API_KEY', 'a' + String.fromCharCode(10) + 'B=c')`, /control character/],
  ['a value over the size cap', `context.writeSecret('ACME_API_KEY', 'x'.repeat(9000))`, /over the 8192/],
  ['a value too short to redact without blanking the rest of the output', `context.writeSecret('ACME_API_KEY', ['ab', 'c'].join(''))`, /under the 8/],
  ['a name the vault cannot reference', `context.writeSecret('ACME KEY', 'a'.repeat(20))`, /cannot name a vault key/],
  ['a value written in the body itself', `context.writeSecret('ACME_API_KEY', 'sk-literal-pasted-0123456789')`, /function's own text.*store-key/s],
  ['a value that is not a string', `context.writeSecret('ACME_API_KEY', { toString() { return 'x'; } })`, /both strings/],
];
for (const [what, call, message] of refusedBeforeAsking) {
  test(`refused without asking: ${what}`, async () => {
    const { final, asked, vault } = await run(`probe() { return ${call}.then(() => 'stored', e => e.message); }`);
    assert.match(String((final as { value: unknown }).value), message);
    assert.equal(asked.length, 0);
    assert.equal(vault.hasKey('ACME_API_KEY'), false);
  });
}

test('a stored value containing another stored value is redacted whole, whichever was written first', async () => {
  // Assembled at run time: a value written out in the body is refused, being in the conversation already.
  const { final } = await run(`probe() {
    const short = ['short', 'key01'].join('-');
    const long = [short, 'TAIL9876'].join('-');
    return context.writeSecret('ACME_A', short).then(() => context.writeSecret('ACME_B', long)).then(() => ({ long }));
  }`);
  assert.deepEqual(final, { type: 'result', value: { long: '[REDACTED]' } });
});

test('a value already in the conversation is still asked about, saying it is exposed', async () => {
  const history = [{ id: 'm1', role: 'tool', content: [{ type: 'tool-result', id: 't1', result: `api_key=${ISSUED}` }] }] as unknown as Message[];
  const { asked } = await run(STORE, { history });
  assert.match(asked[0]?.label ?? '', /already appears in this conversation/);
});
