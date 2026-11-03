import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportsEntry } from '../src/plugins/package-exports.js';

// The CLI imports what this returns with Node, so the answer has to be the one Node's own resolver
// gives for `import 'pkg'` — including matching conditions in the package's order, not ours.

test('string and subpath-map forms', () => {
  assert.equal(exportsEntry('./index.ts'), './index.ts');
  assert.equal(exportsEntry({ '.': './src/index.ts', './sub': './src/sub.ts' }), './src/index.ts');
  assert.equal(exportsEntry({ './sub': './src/sub.ts' }), undefined, 'no main export');
  assert.equal(exportsEntry(undefined), undefined);
});

test('conditions match in the order the package lists them', () => {
  assert.equal(exportsEntry({ '.': { browser: './b.js', import: './i.ts', default: './d.ts' } }), './i.ts');
  assert.equal(exportsEntry({ default: './d.js', import: './i.js' }), './d.js', 'default listed first wins, as in Node');
  assert.equal(exportsEntry({ node: './n.js', import: './i.js' }), './n.js');
  assert.equal(exportsEntry({ module: './m.js', default: './d.js' }), './d.js', 'Node ignores the bundler-only `module`');
  assert.equal(exportsEntry({ require: './r.cjs', browser: './b.js' }), undefined, 'nothing Node would import');
});

test('nested conditions, arrays and null', () => {
  assert.equal(exportsEntry({ '.': { node: { require: './r.cjs', import: './n.mjs' }, default: './d.js' } }), './n.mjs');
  assert.equal(exportsEntry({ node: { require: './r.cjs' }, default: './d.js' }), './d.js', 'an unmatched branch falls through');
  assert.equal(exportsEntry({ '.': [{ browser: './b.js' }, './fallback.js'] }), './fallback.js');
  assert.equal(exportsEntry({ node: null, default: './d.js' }), undefined, 'null excludes rather than falling through');
});
