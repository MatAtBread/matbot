import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { buildAsyncFn, buildBodyFn, runFunction, rewriteImportCalls, EXECUTE_SUBJECT, type CompileHost } from '@matatbread/matbot-function-tools';
import type { MatbotMachine, PermissionRequest, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { createVmFunctionRunner } from '../src/function-runner.ts';

// A tool_function body is meant to be a constrained place to compute: an install that chose `docker-bash`
// over `bash` has not thereby handed `node:fs` to model-authored code. These pin the three parts of that —
// the rewrite that routes `import(…)` through a gate, the globals the runner withholds, and the fact that
// a real `import()` is inert so the gated loader is the only door.

const stripper = { strip: (s: string) => stripTypeScriptTypes(s) };
const machine = (runner: ReturnType<typeof createVmFunctionRunner>): MatbotMachine => ({
  tools: { list: () => [] as Tool[], resolve: () => null, register: () => {}, remove: () => false },
  FunctionRunner: runner,
} as unknown as MatbotMachine);

const asked: PermissionRequest[] = [];
const ctxFor = (allow: boolean): ToolContext => ({
  callId: 'c1', session: { id: 's1' }, signal: new AbortController().signal,
  prompt: () => Promise.reject(new Error('non-interactive')),
  gate: (req: PermissionRequest) => { asked.push(req); return Promise.resolve(allow); },
}) as unknown as ToolContext;

async function result(events: AsyncIterable<ToolEvent>): Promise<ToolEvent | undefined> {
  let final: ToolEvent | undefined;
  for await (const ev of events) final = ev;
  return final;
}

const run = async (host: CompileHost, m: MatbotMachine, def: string, allow = true): Promise<ToolEvent | undefined> => {
  asked.length = 0;
  const fn = await buildAsyncFn(host, def, []);
  return result(runFunction(m, ctxFor(allow), fn, [], { tool: 'probe', source: def }));
};

test('import( is rewritten only in code context', () => {
  // The realistic hazard is a body that GENERATES source: rewriting inside its string would corrupt what
  // it emits, silently. A single regex cannot see template nesting or tell a regex literal from division.
  const same = (src: string): void => assert.equal(rewriteImportCalls(src), src, src);
  assert.equal(rewriteImportCalls(`await import('node:os')`), `await __toolImportModule('node:os')`);
  assert.equal(rewriteImportCalls(`import("node:"+n)`), `__toolImportModule("node:"+n)`);
  assert.equal(rewriteImportCalls("`${await import('a')}`"), "`${await __toolImportModule('a')}`");
  assert.equal(rewriteImportCalls("`${`${await import('a')}`}`"), "`${`${await __toolImportModule('a')}`}`");
  same(`const s = "import('node:fs')"`);
  same("const s = `import('node:fs')`");
  same("const s = `${ \"`\" }import('x')`");
  same(`// import('node:fs')`);
  same(`/* import('node:fs') */`);
  same(`const r = /import\\(/g`);
  same(`import.meta.url`);
  same(`m.import('x')`);
  same(`reimport('x')`);
  same("await tool.x({ definition: `f(){ return import('node:fs'); }` })");
  assert.equal(rewriteImportCalls(`const q = a / b; import('x')`), `const q = a / b; __toolImportModule('x')`);
});

test('a permitted import is gated, and the subject names the function as well as the module', async () => {
  const runner = createVmFunctionRunner(2000, { permit: ['node:'] });
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const ev = await run(host, machine(runner), `probe() { return import('node:os').then(m => typeof m.platform()); }`);
  assert.deepEqual(ev, { type: 'result', value: 'string' });
  assert.equal(asked.length, 1);
  const req = asked[0]!;
  assert.equal(req.gate, 'import');
  // Two-dimensional: a brand-new function must not inherit what a reviewed one earned.
  assert.equal(req.subject, 'probe node:os');
  assert.equal(req.fallback, false);
  // Narrowest first, so a frontend resolving a typed prefix lands on the narrower answer. Each carries
  // its own prose: a subject is a key, and `#execute node:fs/` is a correct key and an unusable question.
  assert.deepEqual(req.standing, [
    { subject: 'probe node:os', label: 'Always allow function "probe" to import node:os' },
    { subject: 'probe node:',   label: 'Always allow function "probe" to import any node builtin' },
    { subject: '* node:os',     label: 'Always allow ANY function to import node:os' },
  ]);
});

test('a submodule offers the directory AND the protocol, not one chosen by its shape', async () => {
  // Picking by shape made the available answer depend on which module a function imported first:
  // `node:fs/promises` offered "any fs submodule" and never "any builtin", and `node:os` the reverse.
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  await run(host, machine(runner), `probe() { return import('node:fs/promises'); }`);
  assert.deepEqual(asked[0]?.standing?.map(o => o.subject),
    ['probe node:fs/promises', 'probe node:fs/', 'probe node:', '* node:fs/promises']);
});

test('with NOTHING configured the gate is still asked — a restriction is not a switch', async () => {
  // The default must reach the prompt. An allow-list defaulting to empty refuses before anyone can be
  // asked, which is the behaviour a permission prompt exists to replace.
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const ev = await run(host, machine(runner), `probe() { return import('node:os').then(m => typeof m.platform()); }`);
  assert.deepEqual(ev, { type: 'result', value: 'string' });
  assert.equal(asked.length, 1, 'asked, not refused out of hand');
  assert.equal(asked[0]?.subject, 'probe node:os');
});

test('a refused gate stops the import', async () => {
  const runner = createVmFunctionRunner(2000);
  const ev = await run({ TypeScriptStripper: stripper, FunctionRunner: runner }, machine(runner),
    `probe() { return import('node:os'); }`, false);
  assert.match((ev as { message: string }).message, /was not permitted/);
  assert.equal(asked.length, 1, 'the gate was consulted');
});

test('a configured restriction refuses outside its set without a prompt, and [] switches imports off', async () => {
  // What a prompt cannot express: "never". A policy has no stored always-deny, so this is the only way.
  const narrowed = createVmFunctionRunner(2000, { permit: ['node:crypto'] });
  const outside = await run({ TypeScriptStripper: stripper, FunctionRunner: narrowed }, machine(narrowed),
    `probe() { return import('node:fs'); }`);
  assert.match((outside as { message: string }).message, /not permitted.*only: node:crypto/s);
  assert.equal(asked.length, 0, 'nothing to ask about: asking would teach that answering yes decides it');

  const off = createVmFunctionRunner(2000, { permit: [] });
  const none = await run({ TypeScriptStripper: stripper, FunctionRunner: off }, machine(off),
    `probe() { return import('node:os'); }`);
  assert.match((none as { message: string }).message, /switched off/);
  assert.equal(asked.length, 0);
});

test('a computed specifier reaches the gate as the string the body built', async () => {
  const runner = createVmFunctionRunner(2000, { permit: ['node:'] });
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const ev = await run(host, machine(runner), `probe() { const n = 'os'; return import('node:' + n).then(m => typeof m.platform); }`);
  assert.deepEqual(ev, { type: 'result', value: 'function' });
  assert.equal(asked[0]?.subject, 'probe node:os', 'the resolved string, not a static guess');
});

test('an execute body keys as `execute`, and its label says the grant is that broad', async () => {
  const runner = createVmFunctionRunner(2000, { permit: ['node:'] });
  asked.length = 0;
  const fn = await buildBodyFn({ TypeScriptStripper: stripper, FunctionRunner: runner },
    `{ return import('node:os').then(m => typeof m.platform()); }`);
  const ev = await result(runFunction(machine(runner), ctxFor(true), fn, [],
    { tool: 'tool_function execute', source: 'x', gateSubject: EXECUTE_SUBJECT }));
  assert.deepEqual(ev, { type: 'result', value: 'string' });
  assert.equal(asked[0]?.subject, '#execute node:os');
  // The subject says `#execute`; the prose never does.
  assert.match(asked[0]!.label, /a one-off function body/);
  assert.ok(asked[0]!.standing?.every(o => !o.label.includes('#')), asked[0]!.standing?.[0]?.label);
});

test('a non-builtin grant says it covers the whole import closure and runs unshadowed', async () => {
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  await run(host, machine(runner), `probe() { return import('lodash-es').catch(() => 'absent'); }`);
  assert.match(asked[0]!.label, /everything it imports/);
  assert.match(asked[0]!.label, /full access, not the function's/);
});

test('a permit must match at a boundary, not as a bare string prefix', async () => {
  // A permit names a thing; a bare startsWith let it admit a sibling whose name merely begins the same
  // way, which is the whole value of naming one.
  const runner = createVmFunctionRunner(2000, { permit: ['https://esm.sh/lodash', 'node:fs'] });
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const refused = async (spec: string): Promise<void> => {
    const ev = await run(host, machine(runner), `probe() { return import(${JSON.stringify(spec)}); }`);
    assert.match((ev as { message: string }).message, /not permitted/, spec);
    assert.equal(asked.length, 0, `${spec} must not even be asked about`);
  };
  await refused('https://esm.sh/lodashhack/x.js');
  await refused('node:fsx');
  // …while the subpaths the permit does name still reach the gate.
  await run(host, machine(runner), `probe() { return import('node:fs/promises').then(() => 1); }`);
  assert.equal(asked[0]?.subject, 'probe node:fs/promises');
});

test('one decision per specifier per invocation, so a loop neither re-prompts nor re-reads', async () => {
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const ev = await run(host, machine(runner),
    `probe() { return Promise.all([import('node:os'), import('node:os'), import('node:path')]).then(ms => ms.length); }`);
  assert.deepEqual(ev, { type: 'result', value: 3 });
  assert.deepEqual(asked.map(r => r.subject), ['probe node:os', 'probe node:path']);
});

test('a function NAMED execute does not share a one-off body\'s standing answers', async () => {
  // `#` cannot start a JS identifier, so the placeholder is unreachable as a function name.
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  asked.length = 0;
  const named = await buildAsyncFn(host, `execute() { return import('node:os').then(() => 1); }`, []);
  await result(runFunction(machine(runner), ctxFor(true), named, [], { tool: 'execute', source: 'x' }));
  assert.equal(asked[0]?.subject, 'execute node:os');
  assert.match(asked[0]!.label, /function "execute"/);

  asked.length = 0;
  const fn = await buildBodyFn(host, `{ return import('node:os').then(() => 1); }`);
  await result(runFunction(machine(runner), ctxFor(true), fn, [], { tool: 'x', source: 'x', gateSubject: EXECUTE_SUBJECT }));
  assert.equal(asked[0]?.subject, '#execute node:os');
});

test('the withheld globals are undefined, and a real import() is inert', async () => {
  const runner = createVmFunctionRunner(2000, { permit: ['node:'] });
  const typeofs = runner.compile([], `return [typeof process, typeof globalThis, typeof Buffer, typeof require, typeof eval].join(',');`);
  assert.equal(await typeofs(), 'undefined,undefined,undefined,undefined,undefined');

  // Nothing is injected here, so the rewrite's target is absent — which is what a body reaches if it
  // somehow gets a real import() past the rewrite: no vm import callback is installed, so it is dead.
  const raw = runner.compile([], `return import('node:os');`);
  await assert.rejects(raw(), (e: { code?: string }) => e.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING');
});

test('the synchronous bound still holds with the shadow wrapper in place', async () => {
  const runner = createVmFunctionRunner(150, { permit: [] });
  const spin = runner.compile([], `while (true) {}`);
  await assert.rejects(spin(), /synchronous work without an await/);
});
