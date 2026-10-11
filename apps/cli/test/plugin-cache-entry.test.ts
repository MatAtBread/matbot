import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Entering a fetched tree from OUTSIDE it. A `tool_function` body whose granted http(s) URL was
// materialised imports the cached file by its own file: URL, from a parent nowhere near `.plugins/` — so
// the resolve branch that answers for imports made INSIDE the tree never fires, and Node is left to work
// out the format itself. A mirrored path takes its name from the URL's pathname, which commonly carries
// no extension at all (`https://esm.sh/lodash`) or a `.js` with no package.json above it to type it.
//
// Module-syntax detection covers both, but only while the format is AMBIGUOUS. A project whose own
// package.json declares `"type": "commonjs"` makes it unambiguous and the cached ESM module fails
// outright, which is the install this would be reported from. So the hooks name the format for anything
// inside a cache tree, exactly as they already do for every import made from INSIDE one.

async function cached(name: string, source: string, packageType?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mb-plugins-'));
  if (packageType !== undefined) await writeFile(join(root, 'package.json'), `{"type":"${packageType}"}`, 'utf8');
  const dir = join(root, '.plugins', 'esm.sh');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, source, 'utf8');
  return pathToFileURL(file).href;
}

test('an extensionless cached module loads as ESM, not ERR_UNKNOWN_FILE_EXTENSION', async () => {
  const url = await cached('lodash', 'export const chunk = (n) => [n];\n');
  const m = await import(url) as { chunk(n: number): number[] };
  assert.deepEqual(m.chunk(1), [1]);
});

test('a cached .js module loads as ESM, not as CommonJS', async () => {
  // No package.json above it, so Node's own answer is CommonJS and the first `export` is a syntax error.
  const url = await cached('x.js', 'export const v = 42;\n');
  const m = await import(url) as { v: number };
  assert.equal(m.v, 42);
});

test('a cached .ts module is still stripped', async () => {
  const url = await cached('y.ts', 'export const v: number = 7;\n');
  const m = await import(url) as { v: number };
  assert.equal(m.v, 7);
});

test('…and under a project that declares itself CommonJS, where detection does not apply', async () => {
  // The case a report would come from. With `"type": "commonjs"` above it the format is no longer
  // ambiguous, so syntax detection never runs and Node refuses the module on its first `export`.
  for (const [name, source] of [['lodash', 'export const v = 1;\n'], ['x.js', 'export const v = 1;\n']] as const) {
    const url = await cached(name, source, 'commonjs');
    const m = await import(url) as { v: number };
    assert.equal(m.v, 1, name);
  }
});

test('a .cjs module in the cache is still CommonJS', async () => {
  // The one extension that states the opposite of what an http origin serves, so it is left alone.
  const url = await cached('legacy.cjs', 'module.exports = { v: 9 };\n');
  const m = await import(url) as { default: { v: number } };
  assert.equal(m.default.v, 9);
});
