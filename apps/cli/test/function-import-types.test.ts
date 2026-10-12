import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { checkSnippetAgainst, ToolTypeIndexImpl } from '@matatbread/matbot-tool-types';
import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

// The permitted set is expressed as `paths`, one entry per module, NOT as `types: ['node']`. The
// difference is the whole point: with `types` every builtin resolves, so a module the install forbids
// typechecks clean and is refused only at run time — correct against the types it was shown, which is the
// one failure the check gate exists to prevent and the repair loop cannot repair.
const root = join(import.meta.dirname, '..', '..', '..');
const nodeTypes = dirname(createRequire(import.meta.url).resolve('@types/node/package.json'));
const PREFIX = `declare const tool: unknown;\n`;

async function check(snippet: string, permitted: string[], apiIndexPath?: string): Promise<string[]> {
  const source = `${PREFIX}${snippet}\nexport {};\n`;
  const report = await checkSnippetAgainst({
    root, source, prefixLen: PREFIX.length, prefixLines: PREFIX.split('\n').length - 1,
    ...(apiIndexPath !== undefined ? { apiIndexPath } : {}),
    importPaths: Object.fromEntries(permitted.map(p => [p, [join(nodeTypes, `${p.slice('node:'.length)}.d.ts`)]])),
    // ENV-GATE rejects what the RUNNER withholds, so the list comes from the runner rather than from a
    // copy here: a name shadowed but not rejected typechecks and fails at the first call.
    withheldGlobals: createVmFunctionRunner(0).withheldGlobals!,
  });
  return report.diagnostics.map(d => `${d.label}: ${d.message}${d.hint !== undefined ? ` | HINT: ${d.hint}` : ''}`);
}

test('a permitted builtin is typed for real, not loosened to any', async () => {
  const ok = await check(`async function f() { const os = await import('node:os'); return os.hostname(); }`, ['node:os']);
  assert.deepEqual(ok, []);
  // If the types had collapsed, this would pass too — which is how a validator that checks nothing looks.
  const typo = await check(`async function f() { const os = await import('node:os'); return os.hstname(); }`, ['node:os']);
  assert.equal(typo.length, 1, typo.join('\n'));
  assert.match(typo[0]!, /hstname/);
});

test('a module outside the permitted set does not resolve, so it fails the CHECK', async () => {
  const out = await check(`async function f() { const fs = await import('node:fs'); return fs.readFileSync('x'); }`, ['node:os']);
  assert.ok(out.length > 0, 'a forbidden module must not typecheck');
  assert.match(out.join('\n'), /node:fs/);
});

test('ENV-GATE covers what the runner WITHHOLDS, not only what a module wrapper would supply', async () => {
  // The list has to match the runner's shadows. The six below were missing, and they are the worse half
  // to omit: `eval` and `Function` are lib.es globals, so they typecheck in every configuration and fail
  // at the first call, and `process.cwd()` drew only tsc's "install type definitions for node" — advice
  // to make a withheld global typecheck. The tool description promises none of them is there.
  const index = indexFor(['node:']);
  for (const [snippet, expected] of [
    [`async function f() { return process.cwd(); }`,                 /'process' is not defined/],
    [`async function f() { return eval('1'); }`,                     /'eval' is not defined/],
    [`async function f() { return new Function('return 1')(); }`,    /'Function' is not defined/],
    [`async function f() { return Buffer.from('x').length; }`,       /'Buffer' is not defined/],
    [`async function f() { return typeof globalThis; }`,             /'globalThis' is not defined/],
    [`async function f() { return typeof (global as never); }`,      /'global' is not defined/],
  ] as const) {
    const out = (await index.check(snippet)).diagnostics;
    const env = out.filter(d => d.label === 'ENV-GATE');
    assert.equal(env.length, 1, `${snippet} -> ${out.map(d => d.label).join(',')}`);
    assert.match(env[0]!.message, expected);
  }

  // A withheld global named in a TYPE is harmless — types are erased before the body is compiled — and a
  // binding the author declared shadows the global and works, so neither may fire. Nor may the SOURCE
  // half of a renamed destructuring: it is a property of the module being unpacked, not the global, and
  // firing on it recommended almost exactly the code it was rejecting.
  for (const ok of [`async function f(cb: Function) { return typeof cb; }`,
                    `async function f() { const process = { cwd: () => 'x' }; return process.cwd(); }`,
                    `async function f() { const { Buffer } = await import('node:buffer'); return typeof Buffer; }`,
                    `async function f() { const { Buffer: B } = await import('node:buffer'); return typeof B; }`]) {
    assert.deepEqual((await index.check(ok)).diagnostics.map(d => d.label), [], ok);
  }
});

test('a builtin whose name already carries the prefix is typed too', async () => {
  // `module.builtinModules` lists node:sea, node:sqlite, node:test and node:test/reporters WITH the
  // prefix, having no unprefixed spelling — so prefixing unconditionally wrote `node:node:sqlite` and
  // those four got no entry at all. `await import('node:sqlite')` then failed the check with tsc's
  // "install type definitions for node", which is the message IMPORT-GATE exists to replace.
  const dts = await indexFor(['node:']).dts();
  for (const m of ['node:sqlite', 'node:sea', 'node:test']) assert.ok(dts.includes(`//   ${m}\n`), m);
  assert.doesNotMatch(dts, /node:node:/);
  const out = await indexFor(['node:']).check(
    `async function f() { const s = await import('node:sqlite'); return typeof s.DatabaseSync; }`);
  assert.deepEqual(out.diagnostics.map(d => `${d.label}: ${d.message}`), []);
});

test('the phantom globals node types would otherwise declare are still rejected', async () => {
  // Loading node's types for `import('node:os')` also declares `require`, `__dirname` and friends, none
  // of which the runner defines. ENV-GATE rejects them structurally rather than letting them typecheck
  // and fail at the first call.
  const out = await check(`async function f() { const fs = require('node:fs'); return fs; }`, ['node:os']);
  assert.equal(out.length, 1, out.join('\n'));
  assert.match(out[0]!, /^ENV-GATE/);
  assert.match(out[0]!, /not defined in a function body/);
  assert.doesNotMatch(out[0]!, /install type definitions/, 'the directed message replaces tsc generic advice');
});

// ── what the dts tells the author ────────────────────────────────────────────
// The permitted set is derived from the runner and reported in the dts, because that string is what a
// body is GRADED against: an author told elsewhere that imports work would still have to guess whether
// the checker agreed.

// The REAL runner, not a stand-in: the environment half of this text is its own words and the withheld
// list is its own list, so a fake one here would be testing a fake's prose and would not notice the two
// drifting apart — which is the failure the division exists to prevent.
const indexFor = (permit: string[] | undefined): ToolTypeIndexImpl => new ToolTypeIndexImpl({
  tools: { list: () => [], resolve: () => null },
  Notifier: { consume: () => {} },
  FunctionRunner: createVmFunctionRunner(0, permit !== undefined ? { permit } : {}),
} as unknown as MatbotMachine, () => Promise.resolve(null));

// No runner at all — any install that did not add the plugin, and the browser. Nothing is withheld and
// nothing is gated, so the gates fall silent and only tsc is left talking.
const indexNoRunner = (): ToolTypeIndexImpl => new ToolTypeIndexImpl({
  tools: { list: () => [], resolve: () => null },
  Notifier: { consume: () => {} },
} as unknown as MatbotMachine, () => Promise.resolve(null));

test('tsc never tells a body to install type definitions', async () => {
  // With no runner ENV-GATE has no list to fire from, so `process` fell through to tsc's TS2591: "Do you
  // need to install type definitions for node? Try `npm i --save-dev @types/node`". There is no
  // package.json to install into, and what a body is typed against is fixed by the runner — so the
  // finding stands and the repair is replaced.
  const out = (await indexNoRunner().check(`async function f() { return process.cwd(); }`)).diagnostics;
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.doesNotMatch(out[0]!.message, /install type definitions|npm i|@types\/node/);
  assert.match(out[0]!.message, /'process' is not declared for a function body/);
  assert.match(out[0]!.message, /already in scope/, 'and it names what a body does have');

  // With a runner the withheld-globals wording is the one that fires, not this fallback: one rule speaks
  // per mistake, and the one that knows most about it goes first.
  const withRunner = (await indexFor(['node:']).check(`async function f() { return process.cwd(); }`)).diagnostics;
  assert.equal(withRunner.length, 1, JSON.stringify(withRunner));
  assert.match(withRunner[0]!.message, /the runner withholds it/);
});

test('the environment fingerprint is stable, and a verdict carries it', async () => {
  // Content-derived, never identity-derived: a stored verdict is compared against this across a restart.
  assert.equal(await indexFor(['node:os']).environment(), await indexFor(['node:os']).environment());
  assert.notEqual(await indexFor(['node:os']).environment(), await indexFor(['node:fs']).environment());
  assert.notEqual(await indexFor(['node:os']).environment(), await indexFor(undefined).environment());
  assert.notEqual(await indexFor(undefined).environment(), await indexNoRunner().environment());
  // Order is not an environment.
  assert.equal(await indexFor(['node:os', 'node:fs']).environment(), await indexFor(['node:fs', 'node:os']).environment());

  const index = indexFor(['node:os']);
  const report = await index.check(`async function f() { return 1; }`);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.environment, await index.environment());
});

test('the dts lists the modules this installation permits, expanding a prefix', async () => {
  const dts = await indexFor(['node:fs/promises', 'node:os']).dts();
  assert.match(dts, /A body may import these, each subject to permission at the call/);
  assert.match(dts, /\/\/\s+node:fs\/promises/);
  assert.match(dts, /\/\/\s+node:os/);
  assert.doesNotMatch(dts, /node:child_process/, 'only what was permitted');

  const all = await indexFor(['node:']).dts();
  // A prefix expands to the builtins that actually have declarations — submodules included.
  for (const m of ['node:fs/promises', 'node:stream/web', 'node:crypto']) assert.match(all, new RegExp(m.replace('/', '\\/')));
  assert.doesNotMatch(all, /node:nonesuch/);
});

test('unrestricted says the rule rather than listing 49 builtins', async () => {
  const dts = await indexFor(undefined).dts();
  assert.match(dts, /may import node builtins, each subject to permission at the call/);
  assert.doesNotMatch(dts, /\/\/\s+node:crypto/, 'the list would be most of the file');
  // Every withheld name is named, and from the runner's own list rather than prose repeated here: the
  // note and what is actually bound cannot drift apart.
  for (const g of createVmFunctionRunner(0).withheldGlobals ?? []) {
    assert.match(dts, new RegExp(`\\b${g}\\b`), `${g} is named in the note`);
  }
});

test('`permit: []` is the one way to say never, and the dts says so', async () => {
  const dts = await indexFor([]).dts();
  assert.match(dts, /Module imports are switched off on this installation/);
});

test('a specifier with no declaration file is listed as untyped, not as imports being off', async () => {
  // Leaving it out of `paths` is right: an entry we cannot type must not resolve, and a fake type is a
  // worse answer than an honest refusal. But the NOTE is the author's only account of what this install
  // allows, and deriving "switched off" from the typed set said imports were off whenever a restriction
  // named no builtin — while the gate was perfectly willing to ask about `lodash`.
  const dts = await indexFor(['node:nope', 'lodash', 'https://esm.sh/x/']).dts();
  assert.doesNotMatch(dts, /switched off/);
  assert.match(dts, /A body may import these/);
  assert.ok(dts.includes('//   lodash   (untyped'));
  // A URL is not merely untyped: no body can import it, so noTypeCheck must not be offered as the way in.
  assert.ok(dts.includes('//   https://esm.sh/x/   (a path or a URL'));
});

test('a path or a URL is refused at the check, whatever is permitted', async () => {
  // The gate refuses these without asking, so a body naming one would otherwise pass the check and fail
  // at its first call.
  for (const spec of ['./helper.js', '/etc/x.mjs', 'https://esm.sh/lodash', 'lodash/../../x']) {
    const out = (await check(`async function f() { await import(${JSON.stringify(spec)}); }`, ['node:os'])).join('\n');
    assert.match(out, /IMPORT-GATE/, spec);
    assert.match(out, /never a path or a URL/, spec);
    assert.doesNotMatch(out, /TS2307/, `one finding, not tsc's as well: ${spec}`);
  }
  assert.deepEqual(await check(`async function f() { const os = await import('node:os'); return os.hostname(); }`, ['node:os']), []);
});

test('a permitted builtin types its submodules, so what runs is what is graded', async () => {
  // `node:fs` admits `node:fs/promises` at the gate (the boundary rule the runner documents), so the
  // check must type it too. Emitting the exact specifier alone left a permitted import failing the
  // check, reachable only with `noTypeCheck` — the one divergence between running and grading.
  const dts = await indexFor(['node:fs']).dts();
  assert.match(dts, /\/\/\s+node:fs$/m);
  assert.match(dts, /\/\/\s+node:fs\/promises$/m, 'the submodule the permit admits is listed too');
  assert.doesNotMatch(dts, /node:fs\s+\(untyped/);

  // Through the real index, so the `paths` it derives is what grades the snippet — the submodule is not
  // in the restriction and must still resolve.
  const report = await indexFor(['node:fs']).check(
    `async function f() { const fs = await import('node:fs/promises'); return fs.readFile('x'); }`);
  assert.deepEqual(report.diagnostics.map(d => `${d.label}: ${d.message}`), []);
});

test("a bare 'node' is answered as the spelling mistake it is, never with a path into our node_modules", async () => {
  // `node` resolves to @types/node's index.d.ts — references and ambient blocks, no export — so tsc says
  // "File '<.../.pnpm/@types+node@x/.../index.d.ts>' is not a module": a package the body never named, in a
  // directory the author has no business reading, handed to the repair loop. It fires with no restriction
  // in force, which is where no other rule is speaking.
  const open = await indexFor(undefined).check(`async function f() { return import('node'); }`);
  assert.equal(open.diagnostics.length, 1, open.diagnostics.map(d => d.message).join('\n'));
  assert.equal(open.diagnostics[0]?.label, 'IMPORT-GATE');
  assert.match(open.diagnostics[0]!.message, /no module called 'node'.*'node:' prefix/s);
  assert.doesNotMatch(open.diagnostics[0]!.message, /node_modules|is not a module/);

  // A restriction that forbids it says so instead — one mistake stays one finding, and the rewrite does
  // not pile a second explanation onto a gate that has already spoken at that position.
  const restricted = await indexFor(['node:fs']).check(`async function f() { return import('node'); }`);
  assert.equal(restricted.diagnostics.length, 1, restricted.diagnostics.map(d => d.message).join('\n'));
  assert.match(restricted.diagnostics[0]!.message, /not permitted on this installation/);
  assert.doesNotMatch(restricted.diagnostics[0]!.message, /node_modules|is not a module/);
});

test("permit: ['node'] types no builtin, and says so rather than offering noTypeCheck", async () => {
  // The boundary rule reads a bare entry as a PACKAGE name (`node` admits `node/sub`, never `node:os`), so
  // an install meaning the builtins and missing the colon permits nothing a body can use. No `@types/node`
  // declaration file is mapped — the question this answers — and the note must not then invite the one
  // import that cannot work.
  const index = indexFor(['node']);
  const dts = await index.dts();
  assert.doesNotMatch(dts, /^\/\/\s+node:/m, 'no builtin is listed');
  assert.match(dts, /\/\/   node   \(a PACKAGE of that name/);
  assert.doesNotMatch(dts, /node   \(untyped/);

  const out = await index.check(`async function f() { const os = await import('node:os'); return os.hostname(); }`);
  assert.equal(out.diagnostics[0]?.label, 'IMPORT-GATE');
  // Its types are genuinely absent, not merely unpermitted: the real check for "is @types/node loaded".
  const typed = await indexFor(['node:os']).check(`async function f() { const os = await import('node:os'); return os.hostname(); }`);
  assert.deepEqual(typed.diagnostics.map(d => d.label), []);
});

test('a forbidden module is rejected STRUCTURALLY, and not as advice to install types', async () => {
  // `paths` alone cannot carry the restriction: one builtin's declaration file drags in the ambient
  // `declare module 'node:…'` blocks of everything its own declarations reference, and whether tsc then
  // resolves a forbidden specifier depends on what is reachable from the program root. So the rule is
  // structural, like ENV-GATE and the cast gate — and it replaces a message that told the author to
  // install type definitions for a module their INSTALLATION forbids, which they cannot act on.
  const out = await indexFor(['node:fs']).check(
    `async function f() { const os = await import('node:os'); return os.hostname(); }`);
  assert.equal(out.diagnostics.length, 1, out.diagnostics.map(d => d.label).join(', '));
  assert.equal(out.diagnostics[0]?.label, 'IMPORT-GATE');
  assert.match(out.diagnostics[0]!.message, /not permitted on this installation, which allows only: node:fs/);
  assert.doesNotMatch(out.diagnostics[0]!.message, /install type definitions/);

  // With imports switched off the message says that instead: there is no permitted module to suggest.
  const off = await indexFor([]).check(`async function f() { return import('node:os'); }`);
  assert.match(off.diagnostics[0]!.message, /switched off on this installation/);

  // Unrestricted ⇒ nothing to enforce, and the gate at the call is the control.
  const open = await indexFor(undefined).check(
    `async function f() { const os = await import('node:os'); return os.hostname(); }`);
  assert.deepEqual(open.diagnostics.map(d => d.label), []);
});

// ── the type side and the gate must agree, in both directions ────────────────
// Each of these was a case where a body typechecked clean and then failed at the first call, or was
// refused by the checker and then permitted at run time. Either way the check gate reports something
// that is not what happens.

test('the unresolvable-module hint does not claim there are no modules', async () => {
  // A constant hint said "only '@matatbread/matbot-plugin-api' is importable here; there are no other
  // modules." It was written for a compiled plugin — which is a module, has a top of file, and really
  // does import only plugin-api — and fired for function bodies too, where it is false for any install
  // that permits a builtin, and where the count it implies is config-dependent anyway.
  const out = (await check(`async function f() { await import('node:defnotamodule'); }`, ['node:os'])).join('\n');
  assert.doesNotMatch(out, /there are no other modules/);
  assert.match(out, /not typed here/, 'it says what IS true: this module has no types here');
  assert.match(out, /noTypeCheck/, 'and how to proceed if the module is real');
});

test('a body is refused plugin-api, which resolves for types and not at run time', async () => {
  // It compiled clean and then died at the first call: the runner's import resolves from the CLI's own
  // module, where under pnpm the package is not present. Withholding the `paths` entry is NOT the fix —
  // the declarations refer to their own types through it, so every one of them would collapse to `any`
  // and bad snippets would pass silently. So it stays resolvable and a body is refused structurally.
  const api = join(root, 'plugin-api', 'src', 'index.ts');
  const out = (await check(`async function f() { await import('@matatbread/matbot-plugin-api'); }`, ['node:os'], api)).join('\n');
  assert.match(out, /IMPORT-GATE/);
  assert.match(out, /in scope for TYPES only/);
  assert.match(out, /already ambient/, 'and says why there is nothing to import');

  // A subpath is the same answer, and the declarations themselves still typecheck — which is what the
  // entry is there for.
  const sub = (await check(`async function f() { await import('@matatbread/matbot-plugin-api/host'); }`, ['node:os'], api)).join('\n');
  assert.match(sub, /IMPORT-GATE/);
  const clean = await check(`async function f() { const os = await import('node:os'); return os.hostname(); }`, ['node:os'], api);
  assert.deepEqual(clean, [], 'nothing collapsed to any');
});

test('a builtin is typed under either spelling, because the runtime takes either', async () => {
  // `import('os')` resolves to `node:os` at run time, so typing only the prefixed form refused at the
  // check what the gate then permitted. With a restriction the bare form is correctly absent from both,
  // the boundary rule not admitting it either.
  const unrestricted = await indexFor(undefined).dts();
  assert.match(unrestricted, /A body may import node builtins/);

  const index = indexFor(undefined);
  const paths = await (index as unknown as { importPaths(): Promise<Record<string, string[]>> }).importPaths();
  assert.ok(paths['node:os'] !== undefined, 'the prefixed spelling');
  assert.ok(paths['os'] !== undefined, 'and the bare one, which the runtime accepts');

  const restricted = await (indexFor(['node:']) as unknown as { importPaths(): Promise<Record<string, string[]>> }).importPaths();
  assert.ok(restricted['node:os'] !== undefined);
  assert.equal(restricted['os'], undefined, "a `node:` restriction does not admit the bare spelling, so it is not typed");
});
