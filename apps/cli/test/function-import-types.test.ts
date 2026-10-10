import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { checkSnippetAgainst, ToolTypeIndexImpl } from '@matatbread/matbot-tool-types';
import type { MatbotMachine } from '@matatbread/matbot-plugin-api';

// The permitted set is expressed as `paths`, one entry per module, NOT as `types: ['node']`. The
// difference is the whole point: with `types` every builtin resolves, so a module the install forbids
// typechecks clean and is refused only at run time — correct against the types it was shown, which is the
// one failure the check gate exists to prevent and the repair loop cannot repair.
const root = join(import.meta.dirname, '..', '..', '..');
const nodeTypes = dirname(createRequire(import.meta.url).resolve('@types/node/package.json'));
const PREFIX = `declare const tool: unknown;\n`;

async function check(snippet: string, permitted: string[]): Promise<string[]> {
  const source = `${PREFIX}${snippet}\nexport {};\n`;
  const report = await checkSnippetAgainst({
    root, source, prefixLen: PREFIX.length, prefixLines: PREFIX.split('\n').length - 1,
    importPaths: Object.fromEntries(permitted.map(p => [p, [join(nodeTypes, `${p.slice('node:'.length)}.d.ts`)]])),
  });
  return report.diagnostics.map(d => `${d.label}: ${d.message}`);
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

const indexFor = (permit: string[] | undefined): ToolTypeIndexImpl => new ToolTypeIndexImpl({
  tools: { list: () => [], resolve: () => null },
  Notifier: { consume: () => {} },
  FunctionRunner: { compile: () => () => Promise.resolve(), ...(permit !== undefined ? { permittedImports: permit } : {}) },
} as unknown as MatbotMachine, () => Promise.resolve(null));

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
  assert.match(dts, /no process, Buffer or globalThis/);
});

test('`permit: []` is the one way to say never, and the dts says so', async () => {
  const dts = await indexFor([]).dts();
  assert.match(dts, /Module imports are switched off on this installation/);
});

test('a specifier with no declaration file is left out, so it cannot typecheck', async () => {
  // Silently skipping is right: an entry we cannot type must not resolve. A bare package is left to
  // ordinary resolution, and an http(s) module is deliberately untyped.
  const dts = await indexFor(['node:nope', 'lodash', 'https://esm.sh/x/']).dts();
  assert.match(dts, /Module imports are switched off on this installation/);
});
