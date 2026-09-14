import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  compareVersions, highestVersion, nextFreePatch, readTree, diffTrees, classifyManifestChange,
  parseChangeset, classifyChangeset, isPublishConflict, mapLimit,
} from '../../../scripts/publish-lib.mjs';

async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-lib-'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const manifest = (extra: object = {}) => JSON.stringify({ name: '@x/a', version: '0.4.7', dependencies: { '@x/b': '^0.4.12' }, ...extra }, null, 2);

async function diffFixtures(local: Record<string, string>, npm: Record<string, string>) {
  const [l, n] = [await fixture(local), await fixture(npm)];
  try { return diffTrees(readTree(l), readTree(n)); } finally { await rm(l, { recursive: true }); await rm(n, { recursive: true }); }
}

test('identical trees are the same, whatever the manifest key order', async () => {
  const d = await diffFixtures(
    { 'package.json': manifest(), 'src/index.ts': 'export {}' },
    { 'package.json': JSON.stringify({ dependencies: { '@x/b': '^0.4.12' }, version: '0.4.7', name: '@x/a' }), 'src/index.ts': 'export {}' },
  );
  assert.equal(d.status, 'same');
});

test('a changed source file is stale and named', async () => {
  const d = await diffFixtures(
    { 'package.json': manifest(), 'src/index.ts': 'export const a = 1' },
    { 'package.json': manifest(), 'src/index.ts': 'export {}' },
  );
  assert.equal(d.status, 'stale');
  assert.deepEqual(d.changed, ['src/index.ts']);
});

test('only dependency ranges moving is advisory, with the ranges listed', async () => {
  const d = await diffFixtures(
    { 'package.json': manifest({ dependencies: { '@x/b': '^0.4.14' } }), 'src/index.ts': 'x' },
    { 'package.json': manifest(), 'src/index.ts': 'x' },
  );
  assert.equal(d.status, 'ranges');
  assert.deepEqual(d.ranges, ['@x/b ^0.4.12 → ^0.4.14']);
});

test('adding a dependency is a real change, not a range move', () => {
  assert.equal(classifyManifestChange(manifest({ dependencies: { '@x/b': '^1', '@x/c': '^1' } }), manifest({ dependencies: { '@x/b': '^1' } })), 'changed');
});

test('a stale manifest names the dependency that was added', async () => {
  const d = await diffFixtures(
    { 'package.json': manifest({ dependencies: { '@x/b': '^0.4.14', '@x/core': '^0.4.14' } }) },
    { 'package.json': manifest() },
  );
  assert.equal(d.status, 'stale');
  assert.deepEqual(d.manifestKeys, ['dependencies.@x/core added']);
});

test('a range repeated across dependency fields is listed once', async () => {
  const d = await diffFixtures(
    { 'package.json': manifest({ dependencies: { '@x/b': '^0.4.14' }, peerDependencies: { '@x/b': '^0.4.14' } }) },
    { 'package.json': manifest({ peerDependencies: { '@x/b': '^0.4.12' } }) },
  );
  assert.deepEqual(d.ranges, ['@x/b ^0.4.12 → ^0.4.14']);
});

test('a file only on npm is stale', async () => {
  const d = await diffFixtures({ 'package.json': manifest() }, { 'package.json': manifest(), 'src/old.ts': 'x' });
  assert.equal(d.status, 'stale');
  assert.deepEqual(d.onlyNpm, ['src/old.ts']);
});

test('a file only local is stale', async () => {
  const d = await diffFixtures({ 'package.json': manifest(), 'src/new.ts': 'x' }, { 'package.json': manifest() });
  assert.equal(d.status, 'stale');
  assert.deepEqual(d.onlyLocal, ['src/new.ts']);
});

test('versions compare by semver, prereleases included', () => {
  assert.equal(compareVersions('0.4.7', '0.4.9'), -1);
  assert.equal(compareVersions('0.4.10', '0.4.9'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
  assert.equal(compareVersions('0.4.7', '0.4.7'), 0);
  assert.equal(highestVersion(['0.4.9', '0.4.10', '0.5.0-beta.1', '0.4.2']), '0.5.0-beta.1');
});

test('behind npm is detectable from the highest version', () => {
  assert.equal(compareVersions('0.4.7', highestVersion(['0.4.7', '0.4.9'])!), -1);
});

test('the suggested patch skips versions npm already has', () => {
  assert.equal(nextFreePatch('0.4.13', ['0.4.13', '0.4.14']), '0.4.15');
  assert.equal(nextFreePatch('0.4.13', ['0.4.13']), '0.4.14');
});

test('changesets are parsed and classified against what differs', () => {
  const releases = parseChangeset('---\n"@x/a": patch\n\'@x/b\': minor\n---\n\nFix things\n');
  assert.deepEqual([...releases], [['@x/a', 'patch'], ['@x/b', 'minor']]);
  assert.deepEqual(classifyChangeset(releases, new Set(['@x/a'])), { status: 'pending', pending: ['@x/a'], needlessMinor: ['@x/b'] });
  assert.equal(classifyChangeset(releases, new Set()).status, 'redundant');
});

test('publish conflicts are recognised in their known wordings', () => {
  assert.ok(isPublishConflict('npm ERR! code EPUBLISHCONFLICT'));
  assert.ok(isPublishConflict('403 Forbidden - PUT https://registry.npmjs.org/@x%2fa - You cannot publish over the previously published versions: 0.4.14.'));
  assert.ok(isPublishConflict('409 Conflict - PUT https://registry.npmjs.org/@x%2fa - Failed to save packument. A common cause is if you try to publish a new package before the previous package has been fully processed. previously staged'));
  assert.ok(isPublishConflict('ERR_PNPM_ E409'));
  assert.ok(!isPublishConflict('npm ERR! code E401 Unable to authenticate'));
  assert.ok(!isPublishConflict('npm ERR! code EOTP'));
});

test('mapLimit keeps order and bounds concurrency', async () => {
  let active = 0, peak = 0;
  const out = await mapLimit([5, 1, 3, 2], 2, async (n: number) => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, n));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20]);
  assert.equal(peak, 2);
});
