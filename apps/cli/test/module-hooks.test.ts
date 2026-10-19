import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// What the CLI's module hooks promise (ts-hooks.js), checked through the hooks this suite itself runs under
// (`--import ./register.js`), against fixtures shaped like matbot's own source and a plugin reload.
const cli = join(import.meta.dirname, '..');

function fixture(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'matbot-hooks-')));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test('a .js import finds the .ts beside it, and a real .js still loads', async () => {
  const dir = fixture({
    'entry.ts': `export { typed } from './typed.js';\nexport { plain } from './plain.js';\n`,
    'typed.ts': `export const typed: string = 'stripped';\n`,
    'plain.js': `export const plain = 'as written';\n`,
  });
  try {
    const mod = await import(pathToFileURL(join(dir, 'entry.ts')).href);
    assert.equal(mod.typed, 'stripped');
    assert.equal(mod.plain, 'as written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Where every dependency lives once published, and where Node's own stripper refuses to go
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
test('TypeScript under node_modules loads', async () => {
  const dir = fixture({
    'node_modules/ts-dep/package.json': JSON.stringify({ name: 'ts-dep', type: 'module', exports: './index.ts' }),
    'node_modules/ts-dep/index.ts': `export const dep: number = 42;\n`,
    'uses-dep.ts': `export { dep } from 'ts-dep';\n`,
  });
  try {
    assert.equal((await import(pathToFileURL(join(dir, 'uses-dep.ts')).href)).dep, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reload stamp reaches a plugin\'s own imports and stops at the host singletons', async () => {
  const fromCore = createRequire(createRequire(join(cli, 'package.json')).resolve('@matatbread/matbot-core'));
  const apiEntry = fromCore.resolve('@matatbread/matbot-plugin-api');
  const dir = fixture({
    'plugin.ts':
      `import * as api from '@matatbread/matbot-plugin-api';\n` +
      `export { leafUrl } from './leaf.js';\n` +
      `export const apiUrl = import.meta.resolve('@matatbread/matbot-plugin-api');\n` +
      `export { api };\n`,
    'leaf.ts': `export const leafUrl: string = import.meta.url;\n`,
  });
  mkdirSync(join(dir, 'node_modules', '@matatbread'), { recursive: true });
  symlinkSync(dirname(dirname(apiEntry)), join(dir, 'node_modules', '@matatbread', 'matbot-plugin-api'), 'dir');
  try {
    const mod = await import(`${pathToFileURL(join(dir, 'plugin.ts')).href}?mbfresh=7`);
    assert.match(mod.leafUrl, /[?&]mbfresh=7(&|$)/, 'first-party imports re-evaluate with the plugin');
    assert.doesNotMatch(mod.apiUrl, /mbfresh/);
    // The point of the boundary: one plugin-api, so `instanceof` still holds across the reload.
    assert.equal(mod.api, await import(pathToFileURL(apiEntry).href));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fetched plugin's imports are answered by the remote loader before the stamp is propagated, and returning
// there unstamped meant a reload re-evaluated only the entry: a refresh re-fetched a changed import to disk,
// but Node handed back the copy it had already evaluated under the same URL. The mirrored tree is written by
// hand, as a materialise leaves it, so nothing here touches the network.
test('a reload stamp reaches a fetched plugin\'s own imports, so a refreshed import re-evaluates', async () => {
  const dir = fixture({
    '.plugins/127.0.0.1:9/.origin': 'http:',
    '.plugins/127.0.0.1:9/p/index.ts': `export { version, leafUrl } from './leaf.js';\n`,
    '.plugins/127.0.0.1:9/p/leaf.ts': `export const version = 1;\nexport const leafUrl: string = import.meta.url;\n`,
  });
  const entry = pathToFileURL(join(dir, '.plugins', '127.0.0.1:9', 'p', 'index.ts')).href;
  try {
    assert.equal((await import(entry)).version, 1);

    writeFileSync(join(dir, '.plugins', '127.0.0.1:9', 'p', 'leaf.ts'),
      `export const version = 2;\nexport const leafUrl: string = import.meta.url;\n`);
    const reloaded = await import(`${entry}?mbfresh=8`);
    assert.match(reloaded.leafUrl, /[?&]mbfresh=8(&|$)/, 'the fetched import is stamped like a local one');
    assert.equal(reloaded.version, 2, 'and so re-evaluates from what the refresh wrote');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `module.register()` runs hooks on a thread of their own, and since Node 24.12 the main thread blocks on a
// round trip to it for every resolve and load. Made to throw here, it proves the CLI no longer calls it.
test('the CLI boots with its hooks in-thread: module.register() is never called', () => {
  const dir = fixture({
    'no-register.mjs':
      `import module, { syncBuiltinESMExports } from 'node:module';\n` +
      `module.register = () => { throw new Error('module.register() was called'); };\n` +
      `syncBuiltinESMExports();\n`,
  });
  try {
    const run = spawnSync(process.execPath,
      ['--import', pathToFileURL(join(dir, 'no-register.mjs')).href, join(cli, 'bin.js'), '--version'],
      { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\d+\.\d+\.\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Stripping is still flagged experimental, and its warning would greet every launch. A run that exits by
// itself, because warnings print on a later tick than `--version`'s `process.exit()` ever reaches.
test('loading TypeScript through the hooks prints no warning', () => {
  const dir = fixture({
    'main.ts': `import { typed } from './typed.js';\nconsole.log(typed);\n`,
    'typed.ts': `export const typed: string = 'loaded';\n`,
  });
  try {
    const run = spawnSync(process.execPath,
      ['--import', pathToFileURL(join(cli, 'register.js')).href, join(dir, 'main.ts')], { encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'loaded', run.stderr);
    assert.equal(run.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
