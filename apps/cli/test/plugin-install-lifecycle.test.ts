import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readlink, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { notAPluginError, type ToolContext, type ToolEvent } from '@matatbread/matbot-core';
import { createPluginTool, materializeRemote, releaseRemote, readInstallRecord, writeInstallRecord, localProvision } from '../src/plugins/index.js';

const execFileP = promisify(execFile);

// What `plugin add` creates, `plugin remove` takes back — and only that (issue #98). matbot's own cache is
// derivable from the config entry; what an install changes in the PROJECT is recorded as it changes it, and
// nothing else in the project is touched. These drive the real executor with a host that loads nothing.

function serve(files: Record<string, string>): Promise<{ origin: string; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    resolve({ origin: `http://127.0.0.1:${port}`, stop: () => new Promise<void>(d => server.close(() => d())) });
  }));
}

const exists = async (p: string): Promise<boolean> => { try { await access(p); return true; } catch { return false; } };

async function project(pkg: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-lifecycle-'));
  await writeFile(join(dir, 'matbot.yaml'), 'plugins:\n');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'host-project', version: '1.0.0', private: true, ...pkg }));
  return { dir, configPath: join(dir, 'matbot.yaml'), dotPlugins: join(dir, '.plugins'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

type Load = (spec: string) => Promise<unknown>;

// A host that asks nobody: every gate is answered by `allow`, and every one asked is recorded.
function run(configPath: string, load: Load, allow: (gate: string) => boolean = () => true) {
  const asked: string[] = [];
  const labels: string[] = [];
  const ctx = {
    callId: 't', signal: new AbortController().signal, prompt: async () => undefined,
    gate: async (req: { gate: string; subject: string; label: string }) => {
      asked.push(`${req.gate} ${req.subject}`);
      labels.push(req.label);
      return { allowed: allow(req.gate), source: 'user' };
    },
    loadPlugin: load, unloadPlugin: async () => true,
  } as unknown as ToolContext;
  const call = async (input: Record<string, unknown>) => {
    const events: ToolEvent[] = [];
    for await (const e of createPluginTool(configPath).executor.execute(input, ctx)) events.push(e as ToolEvent);
    return events.map(e => 'chunk' in e ? e.chunk : 'message' in e ? e.message : JSON.stringify(e)).join('');
  };
  return { asked, labels, call };
}

const configured = async (configPath: string) => (await readFile(configPath, 'utf8')).split('\n').filter(l => /^\s+-/.test(l));
const declared = async (dir: string) => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;

const REMOTE = {
  '/p/package.json': JSON.stringify({ name: '@fixture/matbot-lifecycle', matbotRuntime: ['node'], exports: './index.ts' }),
  '/p/index.ts': `export const plugin = {};\n`,
};

test('removing a fetched plugin takes its cache and its name link with it', async () => {
  const srv = await serve(REMOTE);
  const p = await project();
  try {
    const spec = `${srv.origin}/p/`;
    const { asked, call } = run(p.configPath, async s => { await materializeRemote(s, p.dotPlugins, p.dir); return {}; });
    await call({ action: 'add', specifier: spec });
    const host = new URL(srv.origin).host;
    const link = join(p.dotPlugins, 'node_modules', '@fixture', 'matbot-lifecycle');
    assert.equal(await exists(join(p.dotPlugins, host, 'p', 'index.ts')), true);
    assert.equal(await readlink(link), join(p.dotPlugins, host, 'p'));

    const out = await call({ action: 'remove', specifier: spec });
    assert.match(out, /Removed its cached copy/);
    assert.equal(await exists(join(p.dotPlugins, host, 'p')), false);
    assert.equal(await exists(link), false, 'a removed plugin is no longer importable by name');
    assert.deepEqual(await configured(p.configPath), []);
    assert.deepEqual(asked, [`add ${spec}`, `remove ${spec}`], 'and nothing of the project\'s was offered');
  } finally {
    await srv.stop();
    await p.cleanup();
  }
});

test('a fetched module that is not a plugin is disowned with its cache', async () => {
  const srv = await serve(REMOTE);
  const p = await project();
  try {
    const spec = `${srv.origin}/p/`;
    const { call } = run(p.configPath, async s => {
      await materializeRemote(s, p.dotPlugins, p.dir);
      throw notAPluginError(s, 'it exports no plugin');
    });
    assert.match(await call({ action: 'add', specifier: spec }), /is not a matbot plugin/);
    assert.deepEqual(await configured(p.configPath), []);
    assert.equal(await exists(join(p.dotPlugins, new URL(srv.origin).host, 'p')), false);
    assert.equal(await exists(join(p.dotPlugins, 'node_modules', '@fixture', 'matbot-lifecycle')), false);
  } finally {
    await srv.stop();
    await p.cleanup();
  }
});

// It was first-writer-wins: a plugin installed from github resolved, by name, to the copy an earlier http
// install of it had left — and a link to a removed directory could never be replaced at all.
test('the name link follows the copy materialised last, and a dangling one is repaired', async () => {
  const srv = await serve({ ...REMOTE, '/q/package.json': REMOTE['/p/package.json'], '/q/index.ts': REMOTE['/p/index.ts'] });
  const p = await project();
  try {
    const host = new URL(srv.origin).host;
    const link = join(p.dotPlugins, 'node_modules', '@fixture', 'matbot-lifecycle');
    await mkdir(join(p.dotPlugins, 'node_modules', '@fixture'), { recursive: true });
    await symlink(join(p.dotPlugins, host, 'gone'), link);
    await materializeRemote(`${srv.origin}/p/`, p.dotPlugins, p.dir);
    assert.equal(await readlink(link), join(p.dotPlugins, host, 'p'));
    await materializeRemote(`${srv.origin}/q/`, p.dotPlugins, p.dir);
    assert.equal(await readlink(link), join(p.dotPlugins, host, 'q'));
  } finally {
    await srv.stop();
    await p.cleanup();
  }
});

test('a cached plugin is not released from under another configured plugin\'s files', async () => {
  const srv = await serve({
    '/repo/package.json': JSON.stringify({ name: '@fixture/matbot-root', matbotRuntime: ['node'], exports: './index.ts' }),
    '/repo/index.ts': `export const plugin = {};\n`,
    '/repo/plugins/y/package.json': JSON.stringify({ name: '@fixture/matbot-nested', matbotRuntime: ['node'], exports: './index.ts' }),
    '/repo/plugins/y/index.ts': `export const plugin = {};\n`,
  });
  const p = await project();
  try {
    const root = `${srv.origin}/repo/`, nested = `${srv.origin}/repo/plugins/y/`;
    await materializeRemote(root, p.dotPlugins, p.dir);
    await materializeRemote(nested, p.dotPlugins, p.dir);
    assert.equal(await releaseRemote(root, p.dotPlugins, [nested]), false);
    assert.equal(await releaseRemote(nested, p.dotPlugins, [root]), false);
    assert.equal(await exists(join(p.dotPlugins, new URL(srv.origin).host, 'repo', 'plugins', 'y', 'index.ts')), true);
    assert.equal(await releaseRemote(nested, p.dotPlugins, []), true, 'and is, once nothing else lives there');
  } finally {
    await srv.stop();
    await p.cleanup();
  }
});

// A provider's `module:` is materialised into the same cache, so removing the plugin must not delete it from
// under the provider — including when both name the same specifier.
test('a fetched plugin a provider also loads from keeps its cache on remove', async () => {
  const srv = await serve(REMOTE);
  const p = await project();
  try {
    const spec = `${srv.origin}/p/`;
    const { call } = run(p.configPath, async s => { await materializeRemote(s, p.dotPlugins, p.dir); return {}; });
    await call({ action: 'add', specifier: spec });
    await writeFile(p.configPath, (await readFile(p.configPath, 'utf8')) + `providers:\n  demo:\n    module: "${spec}"\n`);
    const out = await call({ action: 'remove', specifier: spec });
    assert.doesNotMatch(out, /Removed its cached copy/);
    assert.equal(await exists(join(p.dotPlugins, new URL(srv.origin).host, 'p', 'index.ts')), true);
  } finally {
    await srv.stop();
    await p.cleanup();
  }
});

// The npm route, offline: one package served by a registry of our own, which the project's .npmrc points npm
// at — so `npm view` and `npm add` are the real ones, asking it.
async function registry(p: { dir: string }, manifest: Record<string, unknown>, opts: { at?: string; tarball404?: boolean } = {}) {
  const name = manifest['name'] as string;
  const src = join(p.dir, `src-${name}`);
  await mkdir(src, { recursive: true });
  const pkg = { version: '1.0.0', main: 'index.js', ...manifest };
  await writeFile(join(src, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(src, 'index.js'), 'export const plugin = {};\n');
  const { stdout } = await execFileP('npm', ['pack', '--pack-destination', p.dir], { cwd: src });
  const bytes = await readFile(join(p.dir, stdout.trim().split('\n').pop() as string));
  await rm(src, { recursive: true, force: true });

  let origin = '';
  const server = http.createServer((req, res) => {
    if (req.url === `/${name}`) {
      // `npm pack` leaves the tarball in npm's content-addressed cache, so a missing one is advertised under a
      // digest nothing has — otherwise the install would never ask for it.
      const digested = opts.tarball404 === true ? Buffer.from(`absent ${origin}`) : bytes;
      const version = { ...pkg, dist: {
        tarball: `${origin}/${name}.tgz`,
        shasum: createHash('sha1').update(digested).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(digested).digest('base64')}`,
      } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } }));
    } else if (req.url === `/${name}.tgz` && opts.tarball404 !== true) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"Not found"}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
  await writeFile(join(opts.at ?? p.dir, '.npmrc'), `registry=${origin}/\naudit=false\nfund=false\nupdate-notifier=false\n`);
  return { stop: () => new Promise<void>(d => server.close(() => d())) };
}

test('an npm plugin is checked before it is installed, recorded, and remove offers back exactly that', { timeout: 120_000 }, async () => {
  const p = await project();
  const reg = await registry(p, { name: 'fixture-npm-plugin', matbotRuntime: ['node'] });
  try {
    const { asked, call } = run(p.configPath, async () => ({}));
    await call({ action: 'add', specifier: 'fixture-npm-plugin' });
    assert.notEqual((await declared(p.dir))['dependencies']?.['fixture-npm-plugin'], undefined);
    assert.deepEqual(await configured(p.configPath), ['  - fixture-npm-plugin']);
    assert.equal((await readInstallRecord(p.dotPlugins, 'fixture-npm-plugin'))?.dependency, 'fixture-npm-plugin');

    await call({ action: 'remove', specifier: 'fixture-npm-plugin' });
    assert.deepEqual(asked, ['add fixture-npm-plugin', 'remove fixture-npm-plugin', 'npm-uninstall fixture-npm-plugin']);
    assert.equal((await declared(p.dir))['dependencies']?.['fixture-npm-plugin'], undefined);
    assert.equal(await readInstallRecord(p.dotPlugins, 'fixture-npm-plugin'), undefined);
  } finally {
    await reg.stop();
    await p.cleanup();
  }
});

test('a package that is not a matbot plugin is refused before anything is asked or installed', { timeout: 120_000 }, async () => {
  const p = await project();
  const reg = await registry(p, { name: 'fixture-npm-library' });
  try {
    const { asked, call } = run(p.configPath, async () => ({}));
    assert.match(await call({ action: 'add', specifier: 'fixture-npm-library' }), /no "matbotRuntime" field/);
    assert.deepEqual(asked, []);
    assert.equal((await declared(p.dir))['dependencies'], undefined);
    assert.equal(await exists(join(p.dir, 'node_modules')), false);
    assert.deepEqual(await configured(p.configPath), []);
  } finally {
    await reg.stop();
    await p.cleanup();
  }
});

test('an npm plugin that turns out not to load as one is taken back out, unasked', { timeout: 120_000 }, async () => {
  const p = await project();
  const reg = await registry(p, { name: 'fixture-npm-broken', matbotRuntime: ['node'] });
  try {
    const { asked, call } = run(p.configPath, async s => { throw notAPluginError(s, 'it exports no plugin'); });
    assert.match(await call({ action: 'add', specifier: 'fixture-npm-broken' }), /is not a matbot plugin/);
    assert.equal((await declared(p.dir))['dependencies']?.['fixture-npm-broken'], undefined);
    assert.deepEqual(await configured(p.configPath), []);
    assert.equal(await readInstallRecord(p.dotPlugins, 'fixture-npm-broken'), undefined);
    assert.deepEqual(asked, ['add fixture-npm-broken']);
  } finally {
    await reg.stop();
    await p.cleanup();
  }
});

// A fetched plugin's dependencies are planned from its manifest alone — in a scratch directory, where the
// project's .npmrc is not read, so the registry is named in the environment here.
async function withRegistryEnv<T>(p: { dir: string }, fn: () => Promise<T>): Promise<T> {
  const registryUrl = (await readFile(join(p.dir, '.npmrc'), 'utf8')).match(/^registry=(.*)$/m)?.[1] ?? '';
  const saved = { registry: process.env['npm_config_registry'], audit: process.env['npm_config_audit'] };
  process.env['npm_config_registry'] = registryUrl;
  process.env['npm_config_audit'] = 'false';
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[`npm_config_${k}`]; else process.env[`npm_config_${k}`] = v;
    }
  }
}

const DEPENDENT = {
  '/d/package.json': JSON.stringify({ name: '@fixture/matbot-dependent', matbotRuntime: ['node'], exports: './index.ts',
                                      dependencies: { 'fixture-dep': '^1.0.0' } }),
  '/d/index.ts': `export const plugin = {};\n`,
};

test('a fetched plugin\'s dependencies are in the one approval, and installed before it is loaded', { timeout: 120_000 }, async () => {
  const srv = await serve(DEPENDENT);
  const p = await project();
  const reg = await registry(p, { name: 'fixture-dep' });
  try {
    await withRegistryEnv(p, async () => {
      const spec = `${srv.origin}/d/`;
      const root = join(p.dotPlugins, new URL(srv.origin).host, 'd');
      let loads = 0;
      const { asked, labels, call } = run(p.configPath, async s => {
        loads++;
        assert.equal(await exists(join(root, 'node_modules', 'fixture-dep', 'package.json')), true, 'present at load');
        await materializeRemote(s, p.dotPlugins, p.dir);
        return {};
      });
      assert.match(await call({ action: 'add', specifier: spec }), /installed and is now active/);
      assert.deepEqual(asked, [`add ${spec}`], 'one approval, no second offer');
      assert.match(labels[0] ?? '', /into its cache directory:\n- fixture-dep@1\.0\.0/);
      assert.equal(loads, 1);
    });
  } finally {
    await reg.stop();
    await srv.stop();
    await p.cleanup();
  }
});

test('declining a fetched plugin with dependencies fetches and installs nothing', { timeout: 120_000 }, async () => {
  const srv = await serve(DEPENDENT);
  const p = await project();
  const reg = await registry(p, { name: 'fixture-dep' });
  try {
    await withRegistryEnv(p, async () => {
      const { call } = run(p.configPath, async () => { throw new Error('must not load'); }, () => false);
      await call({ action: 'add', specifier: `${srv.origin}/d/` });
      assert.equal(await exists(join(p.dotPlugins, new URL(srv.origin).host)), false);
      assert.deepEqual(await configured(p.configPath), []);
    });
  } finally {
    await reg.stop();
    await srv.stop();
    await p.cleanup();
  }
});

// A refresh can bring a dependency the cached copy never had. It is offered before the new copy is loaded;
// declined, the new copy is never loaded and the working one is put back.
test('a reload offers a new dependency before loading, and declined it restores the working copy', { timeout: 120_000 }, async () => {
  const files: Record<string, string> = { ...REMOTE };
  const srv = await serve(files);
  const p = await project();
  const reg = await registry(p, { name: 'fixture-dep' });
  try {
    await withRegistryEnv(p, async () => {
      const spec = `${srv.origin}/p/`;
      const root = join(p.dotPlugins, new URL(srv.origin).host, 'p');
      const load = async (s: string) => { await materializeRemote(s, p.dotPlugins, p.dir); return {}; };
      await run(p.configPath, load).call({ action: 'add', specifier: spec });
      files['/p/package.json'] = JSON.stringify({ ...JSON.parse(REMOTE['/p/package.json']), dependencies: { 'fixture-dep': '^1.0.0' } });

      const declined = run(p.configPath, load, gate => gate !== 'provision-deps');
      assert.match(await declined.call({ action: 'reload', specifier: spec }), /were not installed[\s\S]*restored and is active again/);
      assert.deepEqual(declined.asked, [`provision-deps ${spec}`]);
      assert.equal(await exists(join(root, 'node_modules', 'fixture-dep')), false);

      let loads = 0;
      const accepted = run(p.configPath, async s => {
        loads++;
        assert.equal(await exists(join(root, 'node_modules', 'fixture-dep', 'package.json')), true, 'present at load');
        return load(s);
      });
      assert.match(await accepted.call({ action: 'reload', specifier: spec }), /reloaded successfully \(1 dependency package/);
      assert.equal(loads, 1);
    });
  } finally {
    await reg.stop();
    await srv.stop();
    await p.cleanup();
  }
});

// Which copy of a package the project carries is the project's decision. Each of these used to install and
// then guess what it had installed; the name it would load under could not be known until afterwards.
test('a version, a tarball or a git URL is refused, saying how to install it instead', async () => {
  const p = await project();
  try {
    const { asked, call } = run(p.configPath, async () => ({}));
    const versioned = await call({ action: 'add', specifier: 'fixture-npm-plugin@2.0.0' });
    assert.match(versioned, /names a version/);
    assert.match(versioned, /plugin reload fixture-npm-plugin/);
    assert.match(await call({ action: 'add', specifier: 'npm:/tmp/fixture-1.0.0.tgz' }), /is not a package name/);
    assert.match(await call({ action: 'add', specifier: 'https://example.com/fixture-1.0.0.tgz' }), /is not a package name/);
    assert.match(await call({ action: 'add', specifier: 'git+https://example.com/fixture.git' }), /is not a package name/);
    // `npm:` past a local package answering to the name: the entry recorded is the name, which would load that one.
    await mkdir(join(p.dir, 'fixture-local'));
    await writeFile(join(p.dir, 'fixture-local', 'package.json'), JSON.stringify({ name: 'fixture-local' }));
    assert.match(await call({ action: 'add', specifier: 'npm:fixture-local' }), /also answers to that name/);
    assert.deepEqual(asked, []);
    assert.deepEqual(await configured(p.configPath), []);
  } finally {
    await p.cleanup();
  }
});

// npm moves an existing devDependency into `dependencies` on `add`, and rewrites a declared range to the latest.
// Neither is the plugin tool's to do: the project's own install is configured as it stands.
test('a plugin the project already has installed is configured as it is, and remove leaves it', async () => {
  const p = await project({ devDependencies: { 'fixture-own': '^1.0.0' } });
  try {
    await mkdir(join(p.dir, 'node_modules', 'fixture-own'), { recursive: true });
    await writeFile(join(p.dir, 'node_modules', 'fixture-own', 'package.json'),
      JSON.stringify({ name: 'fixture-own', version: '1.0.0', main: 'index.js', matbotRuntime: ['node'] }));
    await writeFile(join(p.dir, 'node_modules', 'fixture-own', 'index.js'), 'export const plugin = {};\n');
    const before = await readFile(join(p.dir, 'package.json'), 'utf8');
    const { asked, call } = run(p.configPath, async () => ({}));
    await call({ action: 'add', specifier: 'fixture-own' });
    assert.deepEqual(await configured(p.configPath), ['  - fixture-own']);
    assert.equal(await readInstallRecord(p.dotPlugins, 'fixture-own'), undefined);
    assert.equal(await readFile(join(p.dir, 'package.json'), 'utf8'), before);

    assert.match(await call({ action: 'remove', specifier: 'fixture-own' }), /stays in package\.json/);
    assert.deepEqual(asked, ['add fixture-own', 'remove fixture-own']);
    assert.equal(await readFile(join(p.dir, 'package.json'), 'utf8'), before);
  } finally {
    await p.cleanup();
  }
});

test('a declared package that is not installed, or a project with no package.json, is refused', async () => {
  const p = await project({ dependencies: { 'fixture-unfetched': '^1.0.0' } });
  try {
    const { asked, call } = run(p.configPath, async () => ({}));
    assert.match(await call({ action: 'add', specifier: 'fixture-unfetched' }), /already declares it, but it is not installed/);
    await rm(join(p.dir, 'package.json'));
    assert.match(await call({ action: 'add', specifier: 'fixture-anything' }), /no package\.json/);
    assert.deepEqual(asked, []);
    assert.deepEqual(await configured(p.configPath), []);
  } finally {
    await p.cleanup();
  }
});

// `npm ci` deletes a node_modules before installing and `--package-lock-only` rewrites a lockfile; neither is
// matbot's to do in an author's plugin, so an install the author started is theirs to finish.
test('a local plugin with an install of its own that is incomplete is refused, and left as it is', async () => {
  const p = await project();
  try {
    const local = join(p.dir, 'mine');
    await mkdir(join(local, 'node_modules'), { recursive: true });
    await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'mine', exports: './index.js', dependencies: { 'fixture-dep': '^1.0.0' } }));
    const { asked, call } = run(p.configPath, async () => ({}));
    assert.match(await call({ action: 'add', specifier: './mine' }), /does not have fixture-dep/);

    await rm(join(local, 'node_modules'), { recursive: true });
    await writeFile(join(local, 'package-lock.json'), '{}');
    assert.match(await call({ action: 'add', specifier: './mine' }), /has a package-lock\.json but no node_modules/);
    assert.equal(await readFile(join(local, 'package-lock.json'), 'utf8'), '{}');
    assert.deepEqual(asked, []);
    assert.deepEqual(await configured(p.configPath), []);
  } finally {
    await p.cleanup();
  }
});

// A workspace member's dependencies are hoisted to the root: met where Node finds them, or the refusal would
// ask for an install that can never put them in the member's own node_modules.
test('an author\'s install counts a dependency hoisted to an enclosing node_modules', async () => {
  const p = await project();
  try {
    const local = join(p.dir, 'packages', 'mine');
    await mkdir(join(local, 'node_modules'), { recursive: true });
    await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'mine', dependencies: { 'fixture-dep': '^1.0.0' } }));
    assert.ok('refuse' in await localProvision(local));
    await mkdir(join(p.dir, 'node_modules', 'fixture-dep'), { recursive: true });
    await writeFile(join(p.dir, 'node_modules', 'fixture-dep', 'package.json'), JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }));
    assert.deepEqual(await localProvision(local), { provision: false });
  } finally {
    await p.cleanup();
  }
});

test('a local plugin whose dependency install fails leaves nothing of it behind', { timeout: 120_000 }, async () => {
  const p = await project();
  const local = join(p.dir, 'mine');
  await mkdir(local, { recursive: true });
  await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'mine', exports: './index.js', dependencies: { 'fixture-dep': '^1.0.0' } }));
  const reg = await registry(p, { name: 'fixture-dep' }, { at: local, tarball404: true });
  try {
    const { asked, call } = run(p.configPath, async () => ({}));
    assert.match(await call({ action: 'add', specifier: './mine' }), /What the attempt wrote in .* was removed/);
    assert.deepEqual(asked, ['add ./mine']);
    assert.equal(await exists(join(local, 'node_modules')), false);
    assert.equal(await exists(join(local, 'package-lock.json')), false);
    assert.deepEqual(await configured(p.configPath), []);
  } finally {
    await reg.stop();
    await p.cleanup();
  }
});

test('what installing a local plugin\'s dependencies created is offered back, and kept on a no', async () => {
  for (const allowed of [true, false]) {
    const p = await project();
    try {
      const local = join(p.dir, 'mine');
      await mkdir(join(local, 'node_modules', 'dep'), { recursive: true });
      await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'mine', exports: './index.js' }));
      await writeFile(join(local, 'package-lock.json'), '{}');
      await writeFile(p.configPath, 'plugins:\n  - ./mine\n');
      await writeInstallRecord(p.dotPlugins, { entry: './mine', provisioned: { dir: local, lockfile: true, nodeModules: true } });

      const { asked, call } = run(p.configPath, async () => ({}), gate => gate !== 'remove-provisioned' || allowed);
      await call({ action: 'remove', specifier: './mine' });
      assert.ok(asked.includes(`remove-provisioned ${local}`));
      assert.equal(await exists(join(local, 'node_modules')), !allowed);
      assert.equal(await exists(join(local, 'package-lock.json')), !allowed);
      assert.equal(await exists(join(local, 'package.json')), true, 'the plugin itself is the author\'s');
    } finally {
      await p.cleanup();
    }
  }
});

// `matbotRuntime` is what makes a package a plugin, so discovery passes over a package without it before
// importing anything: a shared helper package beside the plugins — which depends on plugin-api, as a
// library of plugin helpers would — is never run to find out what it is.
test('discover_local lists a declared plugin and never imports an undeclared package', async () => {
  const p = await project();
  try {
    const write = async (name: string, pkg: Record<string, unknown>, src: string) => {
      await mkdir(join(p.dir, 'plugins', name), { recursive: true });
      await writeFile(join(p.dir, 'plugins', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`, exports: './index.ts', peerDependencies: { '@matatbread/matbot-plugin-api': '*' }, ...pkg }));
      await writeFile(join(p.dir, 'plugins', name, 'index.ts'), src);
    };
    await write('real', { matbotRuntime: ['node'] }, `export const plugin = { apiVersion: '1', manifest: { description: 'real' } };\n`);
    await write('helper', {}, `(globalThis as Record<string, unknown>)['__helperImported'] = true;\nexport const plugin = { apiVersion: '1' };\n`);

    const { call } = run(p.configPath, async () => undefined);
    const out = await call({ action: 'discover_local' });
    assert.match(out, /@fixture\/real/);
    assert.doesNotMatch(out, /@fixture\/helper/);
    assert.equal((globalThis as Record<string, unknown>)['__helperImported'], undefined, 'the undeclared package must not be imported');
  } finally { await p.cleanup(); }
});
