import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planProvision, applyProvision, discardProvision, isRegistryRange,
         hostOwnPackageDir } from '@matatbread/matbot-tool-plugin';
import { spawn } from 'node:child_process';

const runNpm = (args: string[], cwd: string): Promise<void> => new Promise((res, rej) => {
  const c = spawn('npm', args, { cwd, stdio: 'ignore' });
  c.on('close', code => code === 0 ? res() : rej(new Error(`npm ${args.join(' ')} exited ${String(code)}`)));
});

// The local route resolved NOTHING: a local plugin's bare imports were whatever happened to be installed
// around it — always true in a workspace checkout, rarely anywhere else — so the identical plugin loaded
// over http and failed as `./mine`, and "wrap a third-party module in a tool" did not work locally at all.
//
// These tests hit the real npm. The packages are tiny and long-published (`debug` → `ms`), which is also
// what makes the resolved set assertable.

async function pluginDir(manifest: Record<string, unknown>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-provision-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: '@local/vendor-wrapper', version: '0.1.0', type: 'module', private: true,
    exports: { '.': './src/index.ts' },
    ...manifest,
  }, null, 2));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const exists = async (p: string): Promise<boolean> => { try { await access(p); return true; } catch { return false; } };

test('a declared dependency and its transitives are resolved before anything is installed', async () => {
  const { dir, cleanup } = await pluginDir({ dependencies: { debug: '^4.3.4' } });
  try {
    const plan = await planProvision(dir);
    // The transitive matters: the approval has to describe what will actually land, not just what was asked for.
    assert.ok(plan.packages.some(p => p.startsWith('debug@4.')), `expected debug, got ${plan.packages.join(', ')}`);
    assert.ok(plan.packages.some(p => p.startsWith('ms@')), `expected the transitive ms, got ${plan.packages.join(', ')}`);
    assert.deepEqual(plan.unsupported, []);
    // Planning writes a lockfile and NOTHING else — that is what makes it presentable-then-abandonable.
    assert.equal(await exists(join(dir, 'package-lock.json')), true);
    assert.equal(await exists(join(dir, 'node_modules')), false, 'planning must not put a package on disk');

    const { linked } = await applyProvision(plan);
    assert.equal(await exists(join(dir, 'node_modules', 'debug')), true);
    assert.equal(await exists(join(dir, 'node_modules', 'ms')), true);

    // Host singletons are LINKED to the host's own copy, never installed from a registry.
    assert.ok(linked.includes('@matatbread/matbot-plugin-api'), `expected plugin-api to be linked, got ${linked.join(', ')}`);
    const target = await realpath(join(dir, 'node_modules', '@matatbread/matbot-plugin-api'));
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { name: string; version: string };
    assert.equal(pkg.name, '@matatbread/matbot-plugin-api');
    const host = JSON.parse(await readFile(new URL('../../../plugin-api/package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(pkg.version, host.version, 'the link must reach the version this host is running');
  } finally {
    await cleanup();
  }
});

// The measured hazard this exists to close: with peers left in, npm fetches a second
// @matatbread/matbot-plugin-api from the registry at whatever version is published — 0.4.4 landed beside
// a host running 0.4.5. A plugin declaring plugin-api as a peer is the normal, documented shape, so this
// is the common case, not an edge one.
test('the host singleton is never fetched from the registry, even declared as a peer', async () => {
  const { dir, cleanup } = await pluginDir({
    dependencies: { debug: '^4.3.4' },
    peerDependencies: { '@matatbread/matbot-plugin-api': '*' },
  });
  try {
    const plan = await planProvision(dir);
    assert.equal(plan.packages.some(p => p.startsWith('@matatbread/')), false,
      `a peer must not appear in the approval list: ${plan.packages.join(', ')}`);
    await applyProvision(plan);
    const linked = await realpath(join(dir, 'node_modules', '@matatbread/matbot-plugin-api'));
    assert.ok(!linked.includes('node_modules/@matatbread/matbot-plugin-api/node_modules'), 'sanity');
    const pkg = JSON.parse(await readFile(join(linked, 'package.json'), 'utf8')) as { version: string };
    const host = JSON.parse(await readFile(new URL('../../../plugin-api/package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(pkg.version, host.version, 'a registry copy would differ from the host version');
  } finally {
    await cleanup();
  }
});

// The regression guard named in the plan: an in-repo plugin's manifest uses `workspace:`/`catalog:`,
// which means "something already resolves me". npm cannot parse those, and rewriting the manifest to hide
// them would be this module resolving dependencies itself. So such a manifest is left entirely alone.
test('a workspace/catalog manifest is left alone rather than partly provisioned', async () => {
  const { dir, cleanup } = await pluginDir({
    dependencies: { '@matatbread/matbot-files-node': 'workspace:^', typescript: 'catalog:', debug: '^4.3.4' },
  });
  try {
    const plan = await planProvision(dir);
    assert.deepEqual(plan.packages, [], 'nothing is installed when any range is not a registry range');
    assert.deepEqual(
      plan.unsupported.map(u => `${u.name}@${u.range}`).sort(),
      ['@matatbread/matbot-files-node@workspace:^', 'typescript@catalog:'],
    );
    assert.equal(await exists(join(dir, 'package-lock.json')), false, 'npm is not even asked');
    // The host singleton is still linked. "Leave the manifest alone" is about not handing unresolvable
    // ranges to a package manager, which is what the assertions above check; it says nothing about
    // whether the host's own copy should be reachable. In the case this stands for — a real in-repo
    // plugin — the workspace has already linked plugin-api to that same directory, so the realpath
    // check finds it and writes nothing (asserted in the sqlite test below).
    assert.deepEqual((await applyProvision(plan)).linked, ['@matatbread/matbot-plugin-api', '@matatbread/matbot-core']);
  } finally {
    await cleanup();
  }
});

test('the real sqlite plugin is recognised as one to leave alone', async () => {
  const dir = new URL('../../../plugins/storage/sqlite', import.meta.url).pathname;
  // Read-only: the workspace has already pointed this plugin's plugin-api at the host's copy, which is
  // why provisioning writes no link here — the realpath matches and there is nothing to replace. Asserted
  // rather than assumed, because it is the reason the case above is safe.
  assert.equal(
    await realpath(join(dir, 'node_modules', '@matatbread/matbot-plugin-api')),
    await realpath(hostOwnPackageDir('@matatbread/matbot-plugin-api')!),
  );
  const plan = await planProvision(dir);
  assert.deepEqual(plan.packages, [], 'an in-repo plugin must not be provisioned');
  assert.equal(await exists(join(dir, 'package-lock.json')), false, 'and must not be given a lockfile');
});

test('a plugin with no dependencies takes exactly the old path', async () => {
  const { dir, cleanup } = await pluginDir({});
  try {
    const plan = await planProvision(dir);
    assert.deepEqual(plan.packages, []);
    assert.deepEqual(plan.unsupported, []);
    assert.equal(await exists(join(dir, 'package-lock.json')), false);
  } finally {
    await cleanup();
  }
});

test('a declined install leaves no lockfile behind', async () => {
  const { dir, cleanup } = await pluginDir({ dependencies: { debug: '^4.3.4' } });
  try {
    const plan = await planProvision(dir);
    assert.equal(await exists(join(dir, 'package-lock.json')), true);
    await discardProvision(plan);
    assert.equal(await exists(join(dir, 'package-lock.json')), false);
    assert.equal(await exists(join(dir, 'node_modules')), false);
  } finally {
    await cleanup();
  }
});

test('a lockfile the author already had is not deleted by a decline', async () => {
  const { dir, cleanup } = await pluginDir({ dependencies: { debug: '^4.3.4' } });
  try {
    await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    const plan = await planProvision(dir);
    assert.equal(plan.hadLockfile, true);
    await discardProvision(plan);
    assert.equal(await exists(join(dir, 'package-lock.json')), true, "someone else's lockfile is not ours to remove");
  } finally {
    await cleanup();
  }
});

test('what counts as a registry range', () => {
  for (const ok of ['^1.2.3', '1.x', 'latest', '>=1.2 <2', '1 || 2', 'npm:other@^1', '*', '']) {
    assert.equal(isRegistryRange(ok), true, `${ok || '(empty)'} should be a registry range`);
  }
  for (const no of ['workspace:^', 'catalog:', 'link:../x', 'file:../x', 'git+ssh://git@host/x.git',
                    'https://example.com/x.tgz', 'github:owner/repo', 'owner/repo', './x', '../x']) {
    assert.equal(isRegistryRange(no), false, `${no} should not be a registry range`);
  }
});

// The host singleton must be reachable from a plugin whether or not that plugin happens to declare a
// third-party dependency. It was not: the link loop sat behind an early return that skipped the whole of
// applyProvision when there was nothing to `npm ci`, so the SIMPLEST plugin there is — one whose only
// dependency is the peer singleton — got no node_modules and no link, and resolved plugin-api by whatever
// sat above it on disk. Every plugin in this repo has dependencies, which is why nothing caught it.
test('the host singleton is linked even when there is nothing to install', async () => {
  const { dir, cleanup } = await pluginDir({ peerDependencies: { '@matatbread/matbot-plugin-api': '^0.4.0' } });
  try {
    const plan = await planProvision(dir);
    assert.deepEqual(plan.packages, [], 'nothing to install is the case under test');
    const { linked } = await applyProvision(plan);
    assert.ok(linked.includes('@matatbread/matbot-plugin-api'), `expected a link, got ${linked.join(', ') || 'none'}`);
    assert.equal(
      await realpath(join(dir, 'node_modules', '@matatbread/matbot-plugin-api')),
      await realpath(hostOwnPackageDir('@matatbread/matbot-plugin-api')!),
    );
  } finally {
    await cleanup();
  }
});

// An author's own devDependency copy is a SECOND physical copy of a singleton — separate module state,
// and `instanceof` false across the seam. The old test was "is anything already here?", which this
// satisfies while being the exact thing the link exists to prevent; the question is whether what is here
// leads to the host's copy. On the path where `npm ci` runs, it is deleted and relinked anyway, so this
// only makes the two paths agree.
test('a second copy of a singleton is replaced by a link to the host\'s', async () => {
  const { dir, cleanup } = await pluginDir({
    devDependencies: { '@matatbread/matbot-plugin-api': '^0.4.0' },
  });
  try {
    await runNpm(['install', '--ignore-scripts'], dir);
    const own = join(dir, 'node_modules', '@matatbread/matbot-plugin-api');
    const host = await realpath(hostOwnPackageDir('@matatbread/matbot-plugin-api')!);
    assert.notEqual(await realpath(own), host, 'the author copy must be a separate directory to start with');

    const { linked } = await applyProvision(await planProvision(dir));
    assert.ok(linked.includes('@matatbread/matbot-plugin-api'));
    assert.equal(await realpath(own), host, 'the duplicate must be replaced by a link to the host copy');
  } finally {
    await cleanup();
  }
});
