import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findDuplicateSingletons, describeDuplicateSingleton } from '@matatbread/matbot-tool-plugin';

// `plugin-api` and `core` are shared across the plugin/host boundary, and a second copy is a different
// module object. matbot is hardened against that (state on `globalThis`, brand-checked errors), so the
// duplication is survivable — which is exactly why nothing would otherwise ever mention it.
//
// The whole difficulty is that most paths which LOOK like a duplicate are not: the symlink farm under
// `.plugins/node_modules`, a compiled plugin's scaffold link and a provisioned plugin dir all contain an
// entry named `@matatbread/matbot-plugin-api` pointing AT the host's copy. Hence realpath, not existence.

const API = '@matatbread/matbot-plugin-api';
const hostApiDir = fileURLToPath(new URL('../../../plugin-api/', import.meta.url));

/** A resolvable package under `<dir>/node_modules`, either a real copy or a link to the host's. */
async function install(dir: string, opts: { link?: boolean; version?: string }): Promise<string> {
  const at = join(dir, 'node_modules', API);
  await mkdir(join(at, '..'), { recursive: true });
  if (opts.link === true) { await symlink(hostApiDir.replace(/\/$/, ''), at, 'dir'); return at; }
  await mkdir(at, { recursive: true });
  await writeFile(join(at, 'package.json'), JSON.stringify({ name: API, version: opts.version, main: 'index.js' }));
  await writeFile(join(at, 'index.js'), 'export const PLUGIN_API_VERSION = "0.4";\n');
  return at;
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-dup-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('nothing is reported when every path leads to the host copy', async () => {
  const { dir, cleanup } = await scratch();
  try {
    // a link, which is what the symlink farm and the compiled-plugin scaffold both write
    await install(dir, { link: true });
    assert.deepEqual(await findDuplicateSingletons({ configDir: dir, plugins: [] }), []);

    // …and a plugin dir carrying the same link
    const pluginDir = join(dir, 'my-plugin');
    await mkdir(pluginDir, { recursive: true });
    await install(pluginDir, { link: true });
    const found = await findDuplicateSingletons({
      configDir: dir,
      plugins: [{ name: 'my-plugin', resolvedUrl: pathToFileURL(join(pluginDir, 'index.ts')).href }],
    });
    assert.deepEqual(found, [], 'a link to the host is the mechanism, not a fault');
  } finally {
    await cleanup();
  }
});

// The shape the http route now writes: `.plugins/node_modules/@matatbread/matbot-plugin-api` → the host's
// own directory, which is how a fetched plugin's bare import reaches the host copy at all. It is the most
// duplicate-LOOKING thing in the tree and must stay silent, or the feature that makes that route work would
// report itself as the fault it exists to avoid.
test('the singleton link the remote cache writes is not a duplicate', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const fetched = join(dir, '.plugins', 'raw.githubusercontent.com', 'o', 'r', 'plugins', 'thing');
    await mkdir(fetched, { recursive: true });
    await install(join(dir, '.plugins'), { link: true });        // linkHostSingletons' output
    const found = await findDuplicateSingletons({
      configDir: dir,
      plugins: [{ name: '@fixture/matbot-thing', resolvedUrl: pathToFileURL(join(fetched, 'index.ts')).href }],
    });
    assert.deepEqual(found, [], 'a link to the host is the mechanism, not a fault');
  } finally {
    await cleanup();
  }
});

test('a real second copy is reported, naming both versions and where it is', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const at = await install(dir, { version: '0.4.4' });
    const found = await findDuplicateSingletons({ configDir: dir, plugins: [] });
    assert.equal(found.length, 1, `expected one duplicate, got ${JSON.stringify(found)}`);
    const dup = found[0]!;
    assert.equal(dup.package, API);
    assert.equal(dup.version, '0.4.4', "the other copy's version");
    assert.notEqual(dup.hostVersion, '0.4.4');
    assert.match(dup.hostVersion, /^\d+\.\d+\.\d+/, "and the host's, so a skew is visible");
    assert.equal(dup.dir, await realpath(at));
    // both versions and the location have to appear in the line a user actually reads
    const line = describeDuplicateSingleton(dup);
    assert.ok(line.includes('0.4.4') && line.includes(dup.hostVersion) && line.includes(dup.dir), line);
  } finally {
    await cleanup();
  }
});

test('a plugin resolving to the second copy is named as reaching it', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const pluginDir = join(dir, 'npm-installed-plugin');
    await mkdir(pluginDir, { recursive: true });
    await install(pluginDir, { version: '0.3.1' });
    const found = await findDuplicateSingletons({
      configDir: dir,
      plugins: [{ name: '@vendor/matbot-thing', resolvedUrl: pathToFileURL(join(pluginDir, 'src', 'index.ts')).href }],
    });
    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.reachedFrom, ['@vendor/matbot-thing'],
      'attribution is the point: it says which plugin is holding the other copy');
    assert.equal(found[0]!.version, '0.3.1');
  } finally {
    await cleanup();
  }
});

test('one copy reached from several places is one finding, not several', async () => {
  const { dir, cleanup } = await scratch();
  try {
    await install(dir, { version: '0.4.4' });          // at the config dir, so everything below inherits it
    const a = join(dir, 'plugin-a'), b = join(dir, 'plugin-b');
    await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
    const found = await findDuplicateSingletons({
      configDir: dir,
      plugins: [
        { name: 'plugin-a', resolvedUrl: pathToFileURL(join(a, 'index.ts')).href },
        { name: 'plugin-b', resolvedUrl: pathToFileURL(join(b, 'index.ts')).href },
      ],
    });
    assert.equal(found.length, 1, 'deduped by copy, not multiplied by reader');
    assert.equal(found[0]!.reachedFrom.length, 3, 'and every reader is listed');
    assert.ok(found[0]!.reachedFrom.includes('plugin-a') && found[0]!.reachedFrom.includes('plugin-b'));
  } finally {
    await cleanup();
  }
});

test('a plugin with no local location is skipped, not guessed at', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const found = await findDuplicateSingletons({
      configDir: dir,
      plugins: [{ name: 'built-by-hand' }, { name: 'fetched', resolvedUrl: 'https://esm.sh/x/index.ts' }],
    });
    assert.deepEqual(found, [], 'absence is not duplication');
  } finally {
    await cleanup();
  }
});

// This repo is the case that matters most: the checkout must be quiet, or the warning is noise everyone
// learns to ignore.
test('this workspace reports no duplication', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const found = await findDuplicateSingletons({ configDir: repo, plugins: [] });
  assert.deepEqual(found, [], `a source checkout must be silent; got ${JSON.stringify(found)}`);
});
