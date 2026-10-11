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
// Both work, on module-syntax detection, which this package's `engines` floor (node >= 24.12) has on by
// default. Pinned here because it is the whole load path for a granted URL and nothing else exercises
// it: without detection the first is ERR_UNKNOWN_FILE_EXTENSION and the second loads as CommonJS, so a
// regression would surface as a granted import failing at the very last step.

async function cached(name: string, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mb-plugins-'));
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
