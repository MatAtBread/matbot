import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readlink, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { notAPluginError, type ToolContext, type ToolEvent } from '@matatbread/matbot-core';
import { pluginTool, materializeRemote, releaseRemote, readInstallRecord, writeInstallRecord } from '@matatbread/matbot-tool-plugin';

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
  const ctx = {
    callId: 't', signal: new AbortController().signal, configPath, prompt: async () => undefined,
    gate: async (req: { gate: string; subject: string }) => {
      asked.push(`${req.gate} ${req.subject}`);
      return { allowed: allow(req.gate), source: 'user' };
    },
    loadPlugin: load, unloadPlugin: async () => true,
  } as unknown as ToolContext;
  const call = async (input: Record<string, unknown>) => {
    const events: ToolEvent[] = [];
    for await (const e of pluginTool.executor.execute(input, ctx)) events.push(e as ToolEvent);
    return events.map(e => 'chunk' in e ? e.chunk : 'message' in e ? e.message : JSON.stringify(e)).join('');
  };
  return { asked, call };
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

// The npm route, offline: a tarball packed from a fixture, installed by the real npm.
async function tarball(dir: string, name: string): Promise<string> {
  const src = join(dir, 'src-pkg');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
  await writeFile(join(src, 'index.js'), 'export const plugin = {};\n');
  const { stdout } = await execFileP('npm', ['pack', '--pack-destination', dir], { cwd: src });
  return join(dir, stdout.trim().split('\n').pop() as string);
}

test('an npm install is recorded, and remove offers back exactly that', { timeout: 120_000 }, async () => {
  const p = await project();
  try {
    const spec = `npm:${await tarball(p.dir, 'fixture-npm-plugin')}`;
    const { asked, call } = run(p.configPath, async () => ({}));
    await call({ action: 'add', specifier: spec });
    assert.equal((await declared(p.dir))['dependencies']?.['fixture-npm-plugin'] !== undefined, true);
    // Configured by the name it installed under: `npm:<tarball>` is not something a restart can load.
    assert.deepEqual(await configured(p.configPath), ['  - fixture-npm-plugin']);
    assert.equal((await readInstallRecord(p.dotPlugins, 'fixture-npm-plugin'))?.dependency, 'fixture-npm-plugin');

    await call({ action: 'remove', specifier: 'fixture-npm-plugin' });
    assert.ok(asked.includes('npm-uninstall fixture-npm-plugin'));
    assert.equal((await declared(p.dir))['dependencies']?.['fixture-npm-plugin'], undefined);
    assert.equal(await readInstallRecord(p.dotPlugins, 'fixture-npm-plugin'), undefined);
  } finally {
    await p.cleanup();
  }
});

test('an npm install that turns out not to be a plugin is taken back out, unasked', { timeout: 120_000 }, async () => {
  const p = await project();
  try {
    const spec = `npm:${await tarball(p.dir, 'fixture-npm-library')}`;
    const { asked, call } = run(p.configPath, async s => { throw notAPluginError(s, 'it exports no plugin'); });
    assert.match(await call({ action: 'add', specifier: spec }), /is not a matbot plugin/);
    assert.equal((await declared(p.dir))['dependencies']?.['fixture-npm-library'], undefined);
    assert.deepEqual(await configured(p.configPath), []);
    assert.equal(await readInstallRecord(p.dotPlugins, 'fixture-npm-library'), undefined);
    assert.deepEqual(asked, [`add ${spec}`]);
  } finally {
    await p.cleanup();
  }
});

// npm moves an existing devDependency into `dependencies` on `add`. Read from `dependencies` alone, that was
// a package the install had introduced, and `remove` offered to uninstall the project's own.
test('a package the project already declared is not the install\'s, and remove leaves it', { timeout: 120_000 }, async () => {
  const p = await project({ devDependencies: { 'fixture-npm-own': '^1.0.0' } });
  try {
    const spec = `npm:${await tarball(p.dir, 'fixture-npm-own')}`;
    const { asked, call } = run(p.configPath, async () => ({}));
    await call({ action: 'add', specifier: spec });
    assert.equal(await readInstallRecord(p.dotPlugins, spec), undefined);
    await call({ action: 'remove', specifier: spec });
    assert.equal(asked.some(a => a.startsWith('npm-uninstall')), false);
    const pkg = await declared(p.dir);
    assert.notEqual(pkg['dependencies']?.['fixture-npm-own'] ?? pkg['devDependencies']?.['fixture-npm-own'], undefined);
  } finally {
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
