import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { buildAsyncFn, buildBodyFn, runFunction, EXECUTE_SUBJECT, type CompileHost } from '@matatbread/matbot-function-tools';
import type { FunctionRunner, MatbotMachine, PermissionRequest, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { permitted, refused } from '@matatbread/matbot-core';
import { ROUTE, createVmFunctionRunner, transformBody } from '@matatbread/matbot-function-runner-node';

// A tool_function body is meant to be a constrained place to compute: an install that chose `docker-bash`
// over `bash` has not thereby handed `node:fs` to model-authored code. These pin the three parts of that —
// the rewrite that routes `import(…)` through a gate, the globals the runner withholds, and the fact that
// a real `import()` is inert so the gated loader is the only door.

const noLoader = { importModule: (): Promise<never> => Promise.reject(new Error('no loader in this test')) };
const stripper = { strip: (s: string) => stripTypeScriptTypes(s) };
const machine = (runner: ReturnType<typeof createVmFunctionRunner>): MatbotMachine => ({
  tools: { list: () => [] as Tool[], resolve: () => null, register: () => {}, remove: () => false },
  FunctionRunner: runner,
} as unknown as MatbotMachine);

// A defined function's subject carries its version (`probe@<digest>`), which every definition below
// changes; these tests are about the module half, so they read it with the version taken off. The
// versioning itself is pinned on its own, further down.
const unversioned = (s: string): string => s.replace(/^([^ @]+)@[0-9a-f]{32}(?= )/, '$1');
const versionedRaw: (PermissionRequest & { namespace?: string })[] = [];
const asked: (PermissionRequest & { namespace?: string })[] = [];
const ctxFor = (allow: boolean): ToolContext => ({
  callId: 'c1', session: { id: 's1' }, signal: new AbortController().signal,
  prompt: () => Promise.reject(new Error('non-interactive')),
  gate: (req: PermissionRequest & { namespace?: string }) => {
    versionedRaw.push(req);
    asked.push({ ...req, subject: unversioned(req.subject),
                 ...(req.standing !== undefined ? { standing: req.standing.map(o => ({ ...o, subject: unversioned(o.subject) })) } : {}) });
    return Promise.resolve(allow ? permitted('user') : refused('user'));
  },
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

// ── the rewrite ────────────────────────────────────────────────────────────────
// The transform is the runner's own — erase the types, route `import(…)` onto a private name — and it
// PARSES. These pin the cases a hand-written scanner got
// wrong — each one silently, by desyncing and leaving a later `import(` unrewritten and so ungated.

// Wrapped the way `compileUnder` wraps — newline-delimited, which is load-bearing: a body ending in a
// line comment would otherwise swallow the closing brace — then unwrapped, so these read as what a
// body's `import(…)` became.
const PRE = '(async function () {\n', POST = '\n})';
const rw = (src: string): string => transformBody(`${PRE}${src}${POST}`)
  .replace(new RegExp(ROUTE.replace('$', '\\$'), 'g'), '__toolImportModule')
  .slice(PRE.length, -POST.length);

test('import( is rewritten in code and nowhere else', () => {
  // The realistic hazard is a body that GENERATES source: rewriting inside its string would corrupt what
  // it emits, silently.
  const same = (src: string): void => assert.equal(rw(src), src, src);
  assert.equal(rw(`await import('node:os')`), `await __toolImportModule('node:os')`);
  assert.equal(rw(`import("node:"+n)`), `__toolImportModule("node:"+n)`);
  assert.equal(rw("`${await import('a')}`"), "`${await __toolImportModule('a')}`");
  assert.equal(rw("`${`${await import('a')}`}`"), "`${`${await __toolImportModule('a')}`}`");
  same(`const s = "await import('x')"`);
  same(`const s = 'await import("x")'`);
  same("const s = `await import('x')`");
  same(`// await import('x')`);
  same(`/* await import('x') */`);
  same(`const u = import.meta.url`);
  // A property named `import` is some object's own method and none of our business. This had to be
  // REFUSED before, being indistinguishable from a call without a parser.
  assert.equal(rw(`const o = { import(x) { return x } }; o.import(1); import('y')`),
               `const o = { import(x) { return x } }; o.import(1); __toolImportModule('y')`);
});

test('a slash that divides does not swallow the rest of the body', () => {
  // Each of these read the `/` as opening a regex, whose own quote then opened a string that ran past
  // the import — which came out unrewritten, and so ungated, with nothing reporting it.
  assert.equal(rw(`let i = 0; const r = i++ / 2; const s = 'a/b'; import('node:fs')`),
               `let i = 0; const r = i++ / 2; const s = 'a/b'; __toolImportModule('node:fs')`);
  assert.equal(rw(`let i = 1; const r = i-- / 2; const s = "a/b"; import('node:fs')`),
               `let i = 1; const r = i-- / 2; const s = "a/b"; __toolImportModule('node:fs')`);
  // After `}` a slash may divide (the brace ended an object literal) or open a regex (it ended a block).
  // Both readings used to be tried and the body refused when they disagreed; the parser just knows.
  assert.equal(rw(`const o = {}; const q = o.a / 1; const s = "a/b"; import('node:fs')`),
               `const o = {}; const q = o.a / 1; const s = "a/b"; __toolImportModule('node:fs')`);
  assert.equal(rw(`const n = {}/a/2; import('x')`), `const n = {}/a/2; __toolImportModule('x')`);
  assert.equal(rw(`if (x) { y() }\n/re/.test(z); import('node:fs')`),
               `if (x) { y() }\n/re/.test(z); __toolImportModule('node:fs')`);
});

test('a regex that follows a close-paren is a regex, not division', () => {
  // The undecidable pair for a scanner: a regex legally follows a braceless `if (…)`, and division
  // legally follows `(a + b)`. Treating `)` as division lost the import below; treating it as a regex
  // would have refused `(a + b) / 2`, which is ordinary code.
  assert.equal(rw(`if (f(x)) /a'b/.test(s); import('node:fs')`),
               `if (f(x)) /a'b/.test(s); __toolImportModule('node:fs')`);
  assert.equal(rw(`while (g()) /x"y/.exec(s); import('node:fs')`),
               `while (g()) /x"y/.exec(s); __toolImportModule('node:fs')`);
  assert.equal(rw(`const r = (a + b) / 2; const s = 'a/b'; import('x')`),
               `const r = (a + b) / 2; const s = 'a/b'; __toolImportModule('x')`);
});

test('a keyword before a slash means regex, and an identifier ending in one divides', () => {
  assert.equal(rw(`return /["']/.test(m) ? import('node:os') : null;`),
               `return /["']/.test(m) ? __toolImportModule('node:os') : null;`);
  assert.equal(rw(`if (typeof /a/ === 'object') import('x');`),
               `if (typeof /a/ === 'object') __toolImportModule('x');`);
  assert.equal(rw(`const n = o.return / b / c; import('x')`),
               `const n = o.return / b / c; __toolImportModule('x')`);
  assert.equal(rw(`const n = myreturn / b / c; import('x')`),
               `const n = myreturn / b / c; __toolImportModule('x')`);
});

test('a body that cannot be parsed is refused, not passed through', () => {
  // TypeScript's parser is error tolerant: it returns a tree for input it could not make sense of, and a
  // call inside the part it gave up on is one the walk never sees. Passing the source back unchanged
  // would hand over an ungated import, so it throws.
  assert.throws(() => rw(`const x = ; import('node:fs')`), /not valid TypeScript/);
});

test('a body is recompiled against the current runner, so one arriving later gates its imports', async () => {
  // The whole environment rides on this — the bound, the withheld globals, and whether `import(…)`
  // reaches the given loader at all — so a body defined before a runner arrived must not keep what it
  // was compiled under. Asserted as the PROPERTY rather than by inspecting what the runner was handed:
  // how a runner routes an import is its own business, and only that it routed is observable.
  let current: ReturnType<typeof createVmFunctionRunner> | undefined;
  const host: CompileHost = { TypeScriptStripper: stripper, get FunctionRunner() { return current; } };
  const fn = await buildAsyncFn(host, `(): Promise<unknown> { return import('node:os'); }`, []);

  const asked: string[] = [];
  const loader = async (spec: string): Promise<unknown> => { asked.push(spec); return { tagged: spec }; };

  // No runner: nothing is routed. The body's own `import(…)` reaches node's loader and the gated one it
  // was handed is never consulted — ungated, which is what the declarations a body is written against say.
  const direct = await fn({ importModule: loader }, null, null, {} as never) as Record<string, unknown>;
  assert.equal(asked.length, 0, 'not routed with no runner');
  assert.equal(typeof direct['arch'], 'function', 'it imported node:os itself');

  // A runner registered afterwards must reach the same compiled function.
  current = createVmFunctionRunner(0, { permit: ['node:'] });
  assert.deepEqual(await fn({ importModule: loader }, null, null, {} as never), { tagged: 'node:os' });
  assert.deepEqual(asked, ['node:os'], 'routed to the loader this call supplied');
});

test('a permitted import is gated, and the subject names the function as well as the module', async () => {
  const runner = createVmFunctionRunner(2000, { permit: ['node:'] });
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const ev = await run(host, machine(runner), `probe() { return import('node:os').then(m => typeof m.platform()); }`);
  assert.deepEqual(ev, { type: 'result', value: 'string' });
  assert.equal(asked.length, 1);
  const req = asked[0]!;
  assert.equal(req.gate, 'import');
  // Under `tool_function`, not the function's own name, so an answer for "any function" is read by all of them.
  assert.equal(req.namespace, 'tool_function');
  // Two-dimensional: a brand-new function must not inherit what a reviewed one earned.
  assert.equal(req.subject, 'probe node:os');
  assert.equal(req.fallback, false);
  // A builtin is no narrow grant: node:child_process runs programs, node:process is the withheld global.
  assert.match(req.label, /full access/);
  // Narrowest first, so a frontend resolving a typed prefix lands on the narrower answer. Each carries
  // its own prose: a subject is a key, and `#execute node:fs/` is a correct key and an unusable question.
  assert.deepEqual(req.standing, [
    { subject: 'probe node:os', label: 'Always allow function "probe" as currently defined to import node:os' },
    { subject: 'probe node:',   label: 'Always allow function "probe" as currently defined to import any node builtin' },
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
  // The thrown message names the module AND the layer that refused: inside a body the model wrote,
  // "not permitted" alone reads as something to debug or route around.
  assert.match((ev as { message: string }).message, /Import of 'node:os': cancelled — the user declined/);
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
  const runner = createVmFunctionRunner(2000, { permit: ['lodash', 'node:fs'] });
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const refused = async (spec: string): Promise<void> => {
    const ev = await run(host, machine(runner), `probe() { return import(${JSON.stringify(spec)}); }`);
    assert.match((ev as { message: string }).message, /not permitted/, spec);
    assert.equal(asked.length, 0, `${spec} must not even be asked about`);
  };
  await refused('lodashhack/x.js');
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

test('a redefinition is a new subject: the version is a digest of what was compiled', async () => {
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const subjectOf = async (def: string, compiled?: string): Promise<string> => {
    versionedRaw.length = 0;
    const fn = await buildAsyncFn(host, def, []);
    await result(runFunction(machine(runner), ctxFor(true), fn, [], { tool: 'probe', source: def, ...(compiled !== undefined ? { compiled } : {}) }));
    return versionedRaw[0]!.subject;
  };
  const one = `probe() { return import('node:os').then(() => 1); }`;
  const two = `probe() { return import('node:os').then(() => 2); }`;
  const a = await subjectOf(one);
  assert.match(a, /^probe@[0-9a-f]{32} node:os$/);
  assert.equal(await subjectOf(one), a, 'the same text is the same subject, across calls and restarts');
  assert.notEqual(await subjectOf(two), a, 'an edit, however small, asks again');
  // A package export's version is the whole package's: a helper it calls can change what it does.
  assert.notEqual(await subjectOf(one, `${one}\nconst helper = 1;`), a);
  // Narrow answers carry the version; the any-function one does not, being the user's to give across versions.
  assert.deepEqual(versionedRaw[0]!.standing?.map(o => o.subject.replace(/@[0-9a-f]{32}/, '@V')), ['probe@V node:os', 'probe@V node:', '* node:os']);
});

test('the withheld globals are undefined, and a real import() is inert', async () => {
  const runner = createVmFunctionRunner(2000, { permit: ['node:'] });
  const typeofs = runner.compile(`(async function () { return [typeof process, typeof globalThis, typeof Buffer, typeof require, typeof eval].join(','); })`);
  assert.equal(await typeofs(noLoader), 'undefined,undefined,function,undefined,undefined', 'Buffer is memory, not a capability');
  assert.deepEqual([...runner.withheldGlobals ?? []].slice(0, 2), ['process', 'globalThis'],
                   'and the list is published, so a checker need not keep its own');

  // The routed import reaches whatever was passed in that argument slot, and nothing else — so a call
  // handed nothing there fails on the call rather than reaching node's own loader.
  // The routed import reaches the loader the CALL was handed and nothing else, so a call given none
  // fails on the call rather than reaching node's own loader.
  const routed = runner.compile(`(async function () { return import('node:os'); })`);
  await assert.rejects(routed({} as never), /not a function/);

  // And an import that gets past the routing — the published escape, since `Function` is only shadowed —
  // is dead anyway: no vm import callback is installed.
  const escaped = runner.compile(`(async function () { return (() => {}).constructor('return import("node:os")')(); })`);
  await assert.rejects(escaped(noLoader), (e: { code?: string }) => e.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING');
});

test('a body has no `this`, so the global it would be cannot hand back what is withheld', async () => {
  // Called with no receiver, a sloppy body's `this` is the real global, and `this.process` reached every
  // builtin with no import — easier than the published `.constructor` escape.
  const runner = createVmFunctionRunner(2000);
  const probe = runner.compile(`(async function () { return [typeof this, typeof (function () { return this; })()].join(','); })`);
  assert.equal(await probe(noLoader), 'undefined,undefined');
});

test('the synchronous bound still holds with the shadow wrapper in place', async () => {
  const runner = createVmFunctionRunner(150, { permit: [] });
  const spin = runner.compile(`(async function () { while (true) {} })`);
  await assert.rejects(spin(noLoader), /synchronous work without an await/);
});

test('removing the time bound removes the TIME bound and nothing else', async () => {
  // `function_timeout_ms: 0` used to seed no runner at all, so a line of yaml about how long a body may
  // compute silently discarded `function_imports.permit` — `permit: []` included, documented as the only
  // way to say never — along with every withheld global and the inert `import()`.
  const unbounded = createVmFunctionRunner(0, { permit: ['node:crypto'] });
  assert.deepEqual([...(await unbounded.settings!()).permittedImports ?? []], ['node:crypto'], 'the restriction is still carried');

  const typeofs = unbounded.compile(`(async function () { return [typeof process, typeof globalThis, typeof eval, typeof require].join(','); })`);
  assert.equal(await typeofs(noLoader), 'undefined,undefined,undefined,undefined', 'still withheld');

  const escaped = unbounded.compile(`(async function () { return (() => {}).constructor('return import("node:os")')(); })`);
  await assert.rejects(escaped(noLoader), (e: { code?: string }) => e.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING',
                       'an unrouted import is still inert');

  // …and the bound really is off: this would be stopped under any positive limit.
  const slow = unbounded.compile(`(async function () { const until = Date.now() + 250; while (Date.now() < until) {} return 'done'; })`);
  assert.equal(await slow(noLoader), 'done');

  // The gate still runs, and still refuses what the restriction excludes.
  const ev = await run({ TypeScriptStripper: stripper, FunctionRunner: unbounded }, machine(unbounded),
    `probe() { return import('node:fs'); }`);
  assert.match((ev as { message: string }).message, /not permitted.*only: node:crypto/s);
});

test('a path or a URL is refused without asking, whatever the restriction says', async () => {
  // Downloading or placing code is a plugin install's job, not a body's. A path also defeats the permit's
  // string match: `./lib/../../x` "starts with" `./lib/` and resolves outside it.
  const runner = createVmFunctionRunner(2000, { permit: ['./lib/', 'lodash', 'https:'] });
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  for (const spec of ['./lib/../../etc/x.mjs', '../x.js', '/etc/x.mjs', 'C:\\x.mjs', 'https://esm.sh/lodash',
                      'file:///etc/x.mjs', 'data:text/javascript,1', 'lodash/../../x', 'lodash/./x',
                      // The resolver is a URL parser: each of these is a `..` segment to it, and each
                      // escaped the package from `typescript/…` before the characters became an allowlist.
                      'lodash/%2e%2e/%2e%2e/x', 'lodash/.%2E/x', 'lodash/%2e./x', 'lodash/.\t./x', 'lodash/.\n./x']) {
    const ev = await run(host, machine(runner), `probe() { return import(${JSON.stringify(spec)}); }`);
    assert.match((ev as { message: string }).message, /only node builtins .*by name/, spec);
    assert.equal(asked.length, 0, `${spec} must not even be asked about`);
    // The runner refuses it too, should anything reach it without the gate.
    await assert.rejects(() => runner.import!(spec), /only node builtins and installed packages/, spec);
  }
});

test('a package that is not installed is reported with where to install it', async () => {
  const runner = createVmFunctionRunner(0, { projectDir: '/tmp/proj' });
  assert.ok(typeof (await runner.import!('node:os') as { arch: unknown }).arch === 'function', 'a builtin is untouched');
  // Node's own message names a file inside matbot that the body never mentioned.
  await assert.rejects(() => runner.import!('nope-not-installed'),
                       (e: Error) => e.message.includes('/tmp/proj') && /not installed where matbot can see it/.test(e.message));
});

test("an import's second argument reaches the loader, so an import attribute works", async () => {
  // Only the keyword is rewritten, so the attributes survive the transform; they were then dropped by a
  // loader that took a specifier alone, and a JSON module failed AFTER the user had granted it.
  const runner = createVmFunctionRunner(2000);
  const seen: unknown[] = [];
  const spy: FunctionRunner = { ...runner, import: (spec, options) => { seen.push(options); return runner.import!(spec, options); } };
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: spy };
  const ev = await run(host, machine(spy),
    `probe() { return import('typescript/package.json', { with: { type: 'json' } }).then(m => m.default.name); }`);
  assert.deepEqual(ev, { type: 'result', value: 'typescript' });
  assert.deepEqual(seen, [{ with: { type: 'json' } }]);
});

test('a definition ending in a line comment compiles, in both shapes', async () => {
  // A one-line wrapper let the comment swallow its closing parenthesis, so a body that typechecked was
  // refused as invalid TypeScript.
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  for (const h of [host, { TypeScriptStripper: stripper }]) {
    const body = await buildBodyFn(h, '{ return 1 } // count');
    assert.equal(await body(noLoader, {}, () => ({}), {} as never), 1);
    const fn = await buildAsyncFn(h, 'probe(): number { return 2 } // two', []);
    assert.equal(await fn(noLoader, {}, () => ({}), {} as never), 2);
  }
});

test('an unprefixed builtin is asked about as the builtin it loads', async () => {
  // Node loads `os` as `node:os` whatever is installed. Asked about as written, it was described as a
  // package running "with everything it imports", offered no "any builtin", and was a second question
  // about one module.
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const ev = await run(host, machine(runner), `probe() { return import('os').then(m => typeof m.platform()); }`);
  assert.deepEqual(ev, { type: 'result', value: 'string' });
  assert.equal(asked[0]?.subject, 'probe node:os');
  assert.doesNotMatch(asked[0]?.label ?? '', /everything it imports/);
  assert.ok(asked[0]?.standing?.some(o => o.subject === 'probe node:'), 'any-builtin is offered');

  // A prefix-only builtin is a package without its prefix, so it is left alone.
  assert.equal(runner.canonicalImport?.('test'), 'test');
  assert.equal(runner.canonicalImport?.('fs/promises'), 'node:fs/promises');

  // A restriction covers both spellings, written either way.
  for (const permit of [['node:'], ['os'], ['node:os']]) {
    const narrowed = createVmFunctionRunner(2000, { permit });
    const h: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: narrowed };
    for (const spec of ['os', 'node:os']) {
      const out = await run(h, machine(narrowed), `probe() { return import('${spec}').then(m => typeof m.platform()); }`);
      assert.deepEqual(out, { type: 'result', value: 'string' }, `${spec} under ${permit.join(',')}`);
    }
  }
});

test('a scoped package root is not offered as its whole scope', async () => {
  // Cut at its last `/`, `@aws-sdk/client-s3` offered "anything under @aws-sdk/" — every package in it.
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  await run(host, machine(runner), `probe() { return import('@aws-sdk/client-s3'); }`, false);
  assert.deepEqual(asked[0]?.standing?.map(o => o.subject), ['probe @aws-sdk/client-s3', '* @aws-sdk/client-s3']);
  await run(host, machine(runner), `probe() { return import('@aws-sdk/client-s3/dist/x'); }`, false);
  assert.deepEqual(asked[0]?.standing?.map(o => o.subject),
    ['probe @aws-sdk/client-s3/dist/x', 'probe @aws-sdk/client-s3/dist/', '* @aws-sdk/client-s3/dist/x']);
});

test('one invocation reads the settings once, and both the gate and the bound answer from that read', async () => {
  // Whose settings they are is the settings store's business — by principal, or not at all — so nothing
  // may be read at boot or cached across invocations. One read per invocation is correct by construction,
  // since an invocation has one principal throughout.
  let reads = 0;
  let permit: readonly string[] | undefined = ['node:os'];
  const runner = createVmFunctionRunner(2000, {}, () => { reads++; return Promise.resolve({ timeoutMs: 150, permit }); });
  const host: CompileHost = { TypeScriptStripper: stripper, FunctionRunner: runner };
  const ok = await run(host, machine(runner),
    `probe() { return Promise.all([import('node:os'), import('os'), import('node:os')]).then(ms => ms.length); }`);
  assert.deepEqual(ok, { type: 'result', value: 3 });
  assert.equal(reads, 1, 'one read for the whole invocation, however many imports it makes');

  // The next invocation reads again, so a change applies with nothing rebuilt.
  permit = ['node:crypto'];
  const refused = await run(host, machine(runner), `probe() { return import('node:os'); }`);
  assert.match((refused as { message: string }).message, /not permitted.*only: node:crypto/s);
  assert.equal(reads, 2);

  // The bound is the one that invocation read, not the one the runner was built with.
  const spun = await run(host, machine(runner), `probe() { for (;;) {} }`);
  assert.match((spun as { message: string }).message, /Stopped after 0.15s/);
});
