import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkSnippetAgainst } from '../../../plugins/tool-types/src/checker.ts';

// The guarantee the tool proxy leans on. `await tool.x(…)` resolves to `undefined` when a tool yields no
// result, because a side-effect tool yields none by design — which means the proxy is no longer the thing
// that catches a body declaring a DATA result and not producing one. That check lives here, where the
// declared return type is in hand, and it already held: `strict` alone rejects a body that can fall
// through, whether it returns nowhere (TS2355) or on only some paths (TS2366).
//
// `noImplicitReturns` was considered for the second case and rejected: TS2366 already covers it precisely,
// and the flag would additionally reject a body declaring `T | undefined` that falls through — honest code
// whose contract permits undefined, which is exactly what the drain hands back. See the last test.

const root = path.resolve(import.meta.dirname, '..');

const check = (source: string) => checkSnippetAgainst({ root, source, prefixLen: 0, prefixLines: 0 });

test('a body declaring a data result must produce one on every path', async () => {
  const report = await check(
    'async function __fn(a: { x: boolean }): Promise<string> {\n' +
    "  if (a.x) return 'yes';\n" +
    '}\n');

  assert.equal(report.checked, true, 'a report that did not run proves nothing');
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(d => d.code === 2366),
            `expected TS2366, got ${JSON.stringify(report.diagnostics.map(d => d.code))}`);
});

test('a body that never returns at all is caught too', async () => {
  const report = await check('async function __fn(): Promise<string> {\n  const x = 1;\n}\n');

  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(d => d.code === 2355),
            `expected TS2355, got ${JSON.stringify(report.diagnostics.map(d => d.code))}`);
});

test('a side-effect body declaring void is unaffected', async () => {
  // The point of the proxy change: this tool is allowed to yield nothing, so it must not be made to look
  // like an error by the check that protects the data case.
  const report = await check(
    'async function __fn(a: { x: boolean }): Promise<void> {\n' +
    '  if (a.x) return;\n' +
    '}\n');

  assert.equal(report.checked, true);
  assert.equal(report.ok, true, `expected clean, got ${JSON.stringify(report.diagnostics.map(d => d.rendered))}`);
});

test('a body whose contract PERMITS undefined may fall through', async () => {
  // Why `noImplicitReturns` is not set. This declares that the result may be absent, the drain resolves to
  // `undefined`, and the two agree — rejecting it would refuse an honest contract to re-catch a case
  // TS2366 already covers.
  const report = await check(
    'async function __fn(a: { x: boolean }): Promise<string | undefined> {\n' +
    "  if (a.x) return 'yes';\n" +
    '}\n');

  assert.equal(report.checked, true);
  assert.equal(report.ok, true, `expected clean, got ${JSON.stringify(report.diagnostics.map(d => d.rendered))}`);
});
