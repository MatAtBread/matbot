import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ToolTypeIndexImpl } from '@matatbread/matbot-tool-types';
import { plugin, FUNCTION_SYNC_LIMIT_MS, createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';
import type {
  FunctionRunner, MatbotMachine, PermissionRequest, Tool, ToolContext, ToolEvent,
} from '@matatbread/matbot-plugin-api';
import { permitted, refused } from '@matatbread/matbot-core';

// The node runner is a PLUGIN, not part of the host: bounding a body, withholding host globals from it
// and gating its imports are all optional, and reachable through the `FunctionRunner` seam alone. These
// pin the two things that moving it out of the host actually changed.

const permitOf = async (r: FunctionRunner): Promise<readonly string[] | undefined> =>
  (await r.settings?.())?.permittedImports;

interface Setup {
  registered: Record<string, unknown>;
  tools:      Map<string, Tool>;
  warnings:   string[];
  /** The per-principal override layer the tool writes, above the install's `floor`. */
  stored:     Record<string, unknown>;
  asked:      PermissionRequest[];
  /** Run the config tool and return its one event. */
  call:       (input: unknown, allow?: boolean) => Promise<ToolEvent>;
}

async function setupWith(
  floor: Record<string, unknown>,
  opts: { projectDir?: string; stored?: Record<string, unknown> } = {},
): Promise<Setup> {
  const registered: Record<string, unknown> = {};
  const tools = new Map<string, Tool>();
  const warnings: string[] = [];
  const stored: Record<string, unknown> = { ...opts.stored };
  const asked: PermissionRequest[] = [];
  // Settings as the host layers them: the stored key if present (`in`, so a stored null is an override),
  // else the installation's `default_settings:` floor. A write touches only the override.
  const settings = {
    get: (k: string) => Promise.resolve(k in stored ? stored[k] : floor[k]),
    set: (k: string, v: unknown) => { stored[k] = v; return Promise.resolve(); },
    delete: (k: string) => { delete stored[k]; return Promise.resolve(); },
  };
  const warn = console.warn;
  const capturing = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
    try { return await fn(); } finally { console.warn = prev; }
  };
  // The runner reads — and so warns — per invocation, long after setup has returned.
  const capturedRunner = (r: FunctionRunner): FunctionRunner => r.settings === undefined ? r
    : Object.assign(Object.create(r) as FunctionRunner, { settings: () => capturing(() => r.settings!()) });
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  try {
    await plugin.setup!({
      settings: () => settings,
      register: (k: string, v: unknown) => {
        registered[k] = k === 'FunctionRunner' ? capturedRunner(v as FunctionRunner) : v;
        return Promise.resolve();
      },
      tools: { register: (t: Tool) => { tools.set(t.name, t); } },
      get FunctionRunner() { return registered['FunctionRunner'] as FunctionRunner | undefined; },
      ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
    } as unknown as MatbotMachine);
  } finally { console.warn = warn; }

  const call = async (input: unknown, allow = true): Promise<ToolEvent> => {
    const ctx = {
      callId: 'c', session: { id: 's' }, signal: new AbortController().signal,
      gate: (req: PermissionRequest) => { asked.push(req); return Promise.resolve(allow ? permitted('user') : refused('user')); },
    } as unknown as ToolContext;
    let last: ToolEvent | undefined;
    for await (const ev of tools.get('function_runner_config')!.executor.execute(input, ctx)) last = ev;
    return last!;
  };
  return { registered, tools, warnings, stored, asked, call };
}

test('the plugin registers a runner built from its own settings', async () => {
  // Its settings, not the host's config: `function_timeout_ms` and `function_imports` were read by
  // apps/cli, which is exactly the coupling moving this out removes.
  const { registered } = await setupWith({ permit_imports: ['node:os'] }, { projectDir: '/tmp/proj' });
  const runner = registered['FunctionRunner'] as FunctionRunner;
  assert.ok(runner !== undefined, 'registered under the service key, like any other plugin');
  assert.deepEqual([...await permitOf(runner) ?? []], ['node:os']);
  assert.ok((runner.withheldGlobals ?? []).includes('process'), 'and it publishes what it withholds');

  // Absent settings are the defaults, and `permittedImports` must stay ABSENT rather than becoming []:
  // an empty list is the configured "never", while no key at all means unrestricted-and-ask.
  const bare = (await setupWith({})).registered['FunctionRunner'] as FunctionRunner;
  assert.equal(await permitOf(bare), undefined, 'no restriction configured ⇒ none claimed');
});

test('timeout_ms: 0 is warned about, and removes the TIME bound only', async () => {
  const { registered, warnings } = await setupWith({ timeout_ms: 0 });
  const runner = registered['FunctionRunner'] as FunctionRunner;
  assert.deepEqual(warnings, [], 'setup reads nothing: whose settings they are is not known until an invocation');
  const settings = await runner.settings!();
  await runner.settings!();
  assert.match(warnings.join('\n'), /run unbounded/);
  assert.match(warnings.join('\n'), /withheld globals and the import gate are unaffected/);
  assert.equal(warnings.length, 1, 'warned once, not on every read');
  assert.ok((runner.withheldGlobals ?? []).includes('eval'), 'still withheld');
  // And the bound really is off: this would be stopped under any positive limit.
  const slow = runner.compile(`(async function () { const u = Date.now() + 250; while (Date.now() < u) {} return 'done'; })`);
  assert.equal(await slow({ importModule: () => Promise.reject(new Error('no loader')), settings }), 'done');
  assert.ok(FUNCTION_SYNC_LIMIT_MS > 0, 'while the default is a real bound');
});

test('the declarations follow the runner with nothing to invalidate', async () => {
  // The obvious thing to reach for, now that the runner is a plugin that can arrive after a dts has been
  // handed out, is a subscription that rebuilds on a `services` registry change. It would be dead weight:
  // nothing derived from the runner is held. The note is composed on every call, `check` passes the two
  // lists fresh to each run, and the one cache over them keys on the permit list's content. What IS
  // cached is the source scan, which the runner has no part in — so subscribing would discard a good
  // TypeScript build to recompute something that was never stale.
  //
  // Asserted by building a dts BEFORE the runner exists and reading it again after, with no event fired.
  let runner: FunctionRunner | undefined;
  const machine = {
    tools: { list: () => [], resolve: () => null },
    Notifier: { consume: () => {} },
    get FunctionRunner() { return runner; },
  } as unknown as MatbotMachine;

  const index = new ToolTypeIndexImpl(machine, () => Promise.resolve(null));
  const before = await index.dts();
  assert.doesNotMatch(before, /Absent:/, 'no runner ⇒ nothing is claimed about what is out of scope');

  runner = createVmFunctionRunner(0, { permit: ['node:os'] });
  const after = await index.dts();
  assert.match(after, /Absent: process[^\n]*\beval\b/, 'the withheld list is there, with no event fired');
  assert.match(after, /node:os/, 'and so is the permitted set');
  index.close();
});

test('the declarations do not promise a prompt that nothing will raise', async () => {
  // Whether an import is GATED is whether a runner routes it, not whether a restriction exists. With no
  // runner nothing rewrites `import(…)` — it reaches node's own loader, unasked — so a body told "you
  // will be asked the first time" discovers the contradiction the first time it imports anything.
  const dtsFor = async (runner: FunctionRunner | undefined): Promise<string> => {
    const index = new ToolTypeIndexImpl({
      tools: { list: () => [], resolve: () => null },
      Notifier: { consume: () => {} },
      FunctionRunner: runner,
    } as unknown as MatbotMachine, () => Promise.resolve(null));
    try { return await index.dts(); } finally { index.close(); }
  };

  const guarded = await dtsFor(createVmFunctionRunner(0));
  assert.match(guarded, /subject to permission at the call/);
  assert.match(guarded, /you will be asked/);

  const bare = await dtsFor(undefined);
  assert.match(bare, /A body may import node builtins/, 'still true: they resolve natively');
  assert.doesNotMatch(bare, /subject to permission/, 'nothing routes the import, so nothing decides it');
  assert.doesNotMatch(bare, /you will be asked/);
});

// ── function_runner_config ─────────────────────────────────────────────────────
// The two settings belong to this plugin, so reading and changing them does too. The host's
// `function_timeout_ms`/`function_imports` could never have worked: the default runner has no way to
// implement either, so the host was parsing a question only a plugin can answer.

test('the config tool reports what is in effect, floor included', async () => {
  const { call } = await setupWith({ permit_imports: ['node:os'] }, { stored: { timeout_ms: 50 } });
  const got = await call({ action: 'get' });
  assert.deepEqual(got, { type: 'result', value: {
    timeoutMs: 50, timeoutMsDefault: FUNCTION_SYNC_LIMIT_MS, permitImports: ['node:os'],
    withheldGlobals: [...createVmFunctionRunner(0).withheldGlobals ?? []],
  } }, 'the override for one key and the install floor for the other — nothing says which is which');
});

test('a change applies from the next invocation, with nothing rebuilt', async () => {
  // The settings are read per invocation, so the runner registered at setup is the runner for good — and
  // a change written anywhere (this tool, another process, a hand-edited document) is simply read next.
  const s = await setupWith({});
  const runner = s.registered['FunctionRunner'] as FunctionRunner;
  assert.equal(await permitOf(runner), undefined, 'unrestricted to begin with');

  const set = await call_ok(await s.call({ action: 'set', permitImports: ['node:os'] }));
  assert.deepEqual(set.permitImports, ['node:os']);
  assert.equal(s.registered['FunctionRunner'], runner, 'the same runner');
  assert.deepEqual([...await permitOf(runner) ?? []], ['node:os']);

  s.stored['timeout_ms'] = 25;
  assert.equal(((await runner.settings!()) as { timeoutMs?: number }).timeoutMs, 25, 'a write that bypassed the tool too');

  // `[]` is the configured "never" and must not read as absent.
  assert.deepEqual((await call_ok(await s.call({ action: 'set', permitImports: [] }))).permitImports, []);
  assert.deepEqual([...await permitOf(runner) ?? ['absent']], []);
});

test('null reverts to the installation default, which is not the same as no restriction', async () => {
  const s = await setupWith({ permit_imports: ['node:os'] }, { stored: { permit_imports: [] } });
  assert.deepEqual([...await permitOf(s.registered['FunctionRunner'] as FunctionRunner) ?? []], []);
  // Not "unrestricted": `delete` means "revert to the configured default", and this install configured one.
  assert.deepEqual((await call_ok(await s.call({ action: 'set', permitImports: null }))).permitImports, ['node:os']);
  assert.equal('permit_imports' in s.stored, false, 'the override is gone, not overwritten with the floor');
  // With no floor the same revert does mean unrestricted.
  const bare = await setupWith({}, { stored: { permit_imports: [] } });
  assert.equal((await call_ok(await bare.call({ action: 'clear' }))).permitImports, null);
});

test('each key is its own decision, and a refusal changes nothing', async () => {
  const s = await setupWith({});
  const refused = await s.call({ action: 'set', permitImports: ['node:fs'] }, false);
  assert.equal(refused.type, 'error');
  assert.match(String((refused as { message: string }).message), /permit_imports. was not changed/);
  assert.equal('permit_imports' in s.stored, false, 'nothing is written before the gate answers');
  assert.deepEqual(s.asked.map(r => [r.gate, r.subject]), [['set', 'permit_imports']]);
  // The label is the question, not the key, and names what is in force now.
  assert.match(s.asked[0]!.label, /may import/);
  assert.deepEqual(s.asked[0]!.standing?.map(a => a.subject), ['permit_imports', '*'], 'narrowest first');

  s.asked.length = 0;
  await s.call({ action: 'set', permitImports: ['node:fs'], timeoutMs: 10 });
  assert.deepEqual(s.asked.map(r => r.subject).sort(), ['permit_imports', 'timeout_ms'],
    'two settings are two questions: a standing answer for one must not carry the other');

  // A set that asks for nothing, and a bad value, are refused before any gate is raised.
  s.asked.length = 0;
  assert.equal((await s.call({ action: 'set' })).type, 'error');
  assert.equal((await s.call({ action: 'set', timeoutMs: -1 })).type, 'error');
  assert.equal((await s.call({ action: 'set', permitImports: [''] })).type, 'error');
  assert.deepEqual(s.asked, []);
});

function call_ok(ev: ToolEvent): Promise<{ permitImports: string[] | null; timeoutMs: number }> {
  assert.equal(ev.type, 'result', JSON.stringify(ev));
  return Promise.resolve((ev as { value: { permitImports: string[] | null; timeoutMs: number } }).value);
}

test('settings that reach the runner without the tool are checked too', async () => {
  // `default_settings:` and a hand-edited document never pass through `set`. A negative bound used to
  // run bodies unbounded without the timeout_ms: 0 warning, and a scalar restriction made every import
  // throw `permits.some is not a function`.
  const neg = await setupWith({ timeout_ms: -1 });
  await (neg.registered['FunctionRunner'] as FunctionRunner).settings!();
  assert.match(neg.warnings.join('\n'), /timeout_ms must be a non-negative integer/);
  const got = await call_ok(await neg.call({ action: 'get' }));
  assert.equal(got.timeoutMs, FUNCTION_SYNC_LIMIT_MS, 'the coded default, not unbounded');
  assert.equal(got.problems?.length, 1, 'and get says why');

  // A bad RESTRICTION fails closed: falling back to "no restriction" would turn a typo into the widest
  // setting there is.
  for (const bad of ['node:', { permit: ['node:'] }, ['./lib/'], ['https://esm.sh/'], null]) {
    const s = await setupWith({ permit_imports: bad });
    assert.deepEqual([...await permitOf(s.registered['FunctionRunner'] as FunctionRunner) ?? ['absent']], [], JSON.stringify(bad));
    assert.match(s.warnings.join('\n'), /switched off until it is corrected/, JSON.stringify(bad));
  }
});

test('set refuses a restriction entry naming a path or a URL', async () => {
  const s = await setupWith({});
  const ev = await s.call({ action: 'set', permitImports: ['node:os', './lib/'] });
  assert.equal(ev.type, 'error');
  assert.match((ev as { message: string }).message, /\.\/lib\/.*never paths or URLs/);
  assert.equal(s.asked.length, 0, 'refused before anyone is asked');
  assert.deepEqual(s.stored, {});
});
