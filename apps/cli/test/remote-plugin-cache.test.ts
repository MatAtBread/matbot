import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { materializeRemote, remoteDependencyNotes } from '@matatbread/matbot-tool-plugin';

// A remote plugin is fetched over HTTP and mirrored into `.plugins/`, and the mirrored tree IS the
// cache. Two properties of that were absent while it was write-only: a warm boot re-downloaded every
// file (and then discarded what came back, since `writeCached` will not overwrite), and a boot with a
// fully populated tree and an unreachable server dropped the plugin entirely.
//
// The third property is that it stops *guessing*. A declared dependency nothing satisfies is reported from
// the manifest; an unsatisfied IMPORT is no longer predicted from the source at all, because the module hook
// fails the resolution it actually attempted (see remote-import-hook.test.ts).

interface Served { path: string; status: number }

function serve(files: Record<string, string>): Promise<{ origin: string; log: Served[]; stop: () => Promise<void> }> {
  const log: Served[] = [];
  const server = http.createServer((req, res) => {
    const body = files[req.url ?? ''];
    log.push({ path: req.url ?? '', status: body === undefined ? 404 : 200 });
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    resolve({
      origin: `http://127.0.0.1:${port}`,
      log,
      stop: () => new Promise<void>(done => server.close(() => done())),
    });
  }));
}

const FILES: Record<string, string> = {
  '/a/package.json': JSON.stringify({
    name: '@fixture/matbot-remote-a',
    matbotRuntime: ['node'],
    exports: { '.': './index.ts' },
    // one matbot plugin (nothing installs it on this route) and one ordinary registry package
    dependencies: { '@fixture/matbot-remote-b': '1.0.0', 'left-pad': '^1.0.0' },
  }),
  '/a/index.ts': `import './helper.js';\nimport type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';\nexport const plugin = { apiVersion: '0.4' } as MatbotPluginSpec;\n`,
  // what esm.sh rewrites a dependency import to — no package name to link, so it used to vanish
  '/a/helper.ts': `import '/ms@2.1.3/es2022/ms.mjs';\nexport const helper = 1;\n`,
  '/b/package.json': JSON.stringify({ name: '@fixture/matbot-remote-b', matbotRuntime: ['node'], exports: { '.': './index.ts' } }),
  '/b/index.ts': `export const plugin = { apiVersion: '0.4' };\n`,
};

test('a warm materialise asks for nothing, and so works with the server gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-cache-'));
  const dotPlugins = join(dir, '.plugins');
  const srv = await serve(FILES);
  try {
    const first = await materializeRemote(`${srv.origin}/a/`, dotPlugins, dir);
    assert.equal(await readFile(first.entry, 'utf8'), FILES['/a/index.ts']);
    // The manifest and the entry, and no more: the rest of the graph is fetched by the module hook as
    // Node resolves it, which is why `helper.ts` is absent here.
    assert.deepEqual(srv.log.filter(r => r.status === 200).map(r => r.path), ['/a/package.json', '/a/index.ts']);

    // Same URLs under a different specifier string, so the in-process manifest memo cannot answer and
    // the mirrored tree has to. Nothing at all should reach the server — not even the `.js` probe that
    // precedes each module, which is why every candidate is tried on disk before any is tried live.
    srv.log.length = 0;
    await materializeRemote(`${srv.origin}/a/package.json`, dotPlugins, dir);
    assert.deepEqual(srv.log, [], 'a warm materialise makes no requests');

    // Which is the whole of the offline story: with the tree populated there is nothing to ask for.
    await srv.stop();
    const offline = await materializeRemote(`${srv.origin}/a/index.ts`, dotPlugins, dir);
    assert.equal(await readFile(offline.entry, 'utf8'), FILES['/a/index.ts']);
  } finally {
    await srv.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

// The mirrored tree never being re-fetched is what makes `reload --refresh` the only path to upstream,
// so that path has to actually reach it — including the manifest, since a refresh exists precisely to
// pick up a moved entry or a renamed package.
test('only a refresh reaches upstream, and it re-reads the manifest too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-refresh-'));
  const dotPlugins = join(dir, '.plugins');
  const files = { ...FILES };
  const srv = await serve(files);
  try {
    const spec = `${srv.origin}/a/`;
    await materializeRemote(spec, dotPlugins, dir);

    const original = FILES['/a/index.ts'] ?? '';
    files['/a/index.ts'] = `export const changed = true;\n${original}`;
    // …and move the entry, so a stale manifest would be visible as the wrong file being crawled.
    files['/a/moved.ts'] = `export const plugin = { apiVersion: '0.4' };\n`;
    files['/a/package.json'] = JSON.stringify({
      name: '@fixture/matbot-remote-a', matbotRuntime: ['node'], exports: { '.': './moved.ts' },
    });

    srv.log.length = 0;
    const stale = await materializeRemote(`${srv.origin}/a/index.ts`, dotPlugins, dir);
    assert.equal(await readFile(stale.entry, 'utf8'), original, 'without a refresh the mirrored copy stands');
    assert.deepEqual(srv.log, [], 'and upstream is not consulted at all');

    const refreshed = await materializeRemote(spec, dotPlugins, dir, /* forceRefresh */ true);
    assert.match(refreshed.entry, /moved\.ts$/, 'a refresh re-reads the manifest, so the moved entry is found');
    assert.equal(await readFile(refreshed.entry, 'utf8'), files['/a/moved.ts']);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// A declared asset that never cached is retried on every boot, so its fetch is the one request a warm
// boot can still make — and the one that can therefore fail with no network. Best-effort has to mean
// best-effort, or a plugin's unfetchable extra file takes the whole boot down offline.
test('a declared file that cannot be fetched does not fail the materialise', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-asset-'));
  const dotPlugins = join(dir, '.plugins');
  const files: Record<string, string> = {
    '/c/package.json': JSON.stringify({
      name: '@fixture/matbot-remote-c', matbotRuntime: ['node'],
      exports: { '.': './index.ts' }, files: ['never-served.json'],
    }),
    '/c/index.ts': `export const plugin = { apiVersion: '0.4' };\n`,
  };
  const srv = await serve(files);
  try {
    const spec = `${srv.origin}/c/`;
    await materializeRemote(spec, dotPlugins, dir);              // 404 on the asset: warned, not fatal
    await srv.stop();
    const offline = await materializeRemote(`${srv.origin}/c/index.ts`, dotPlugins, dir);
    assert.equal(await readFile(offline.entry, 'utf8'), files['/c/index.ts']);
  } finally {
    await srv.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('a declared dependency nothing satisfies is reported, named well enough to act on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-notes-'));
  const dotPlugins = join(dir, '.plugins');
  const srv = await serve(FILES);
  try {
    const a = await materializeRemote(`${srv.origin}/a/`, dotPlugins, dir);
    const notes = (await remoteDependencyNotes(a)).join('\n');

    // A declared dependency that looks like a matbot plugin says where to put it.
    assert.match(notes, /"@fixture\/matbot-remote-b".*plugins:/s);
    // An ordinary registry dependency says this route installs nothing.
    assert.match(notes, /"left-pad"/);
    assert.match(notes, /installs no dependencies/);
    // A host singleton is not a finding: it resolves to the host's copy by construction.
    assert.equal(/matbot-plugin-api/.test(notes), false);

    // A sibling plugin configured LATER is not on disk while this one is being fetched, so the
    // check is deferred: once B exists, its finding must go, and only its finding.
    await materializeRemote(`${srv.origin}/b/`, dotPlugins, dir);
    const after = (await remoteDependencyNotes(a)).join('\n');
    assert.equal(/matbot-remote-b/.test(after), false, 'the sibling now resolves, so it is no longer reported');
    assert.match(after, /"left-pad"/, 'the genuinely missing dependency still is');
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// The one function pnpm's `#path:` fragment was ever reached for: install a plugin that lives in a
// SUBDIRECTORY of a repo. No package manager can do it usefully here — npm ignores the fragment and
// installs the whole monorepo under the repo's name (reporting success), pnpm extracts the right
// package but leaves its `workspace:` peers unmet — and matbot needs neither, because the http route
// fetches one package's files and resolves bare imports against the host. So the fragment is only a
// spelling, and this is the mechanism under it.
test('a plugin in a repo subdirectory is fetched as a package, workspace peers and all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-subdir-'));
  const dotPlugins = join(dir, '.plugins');
  // The shape a real monorepo serves: a root manifest above, the plugin nested well below it, and a
  // `workspace:^` peer that would defeat an install.
  const files: Record<string, string> = {
    '/repo/HEAD/package.json': JSON.stringify({ name: 'the-monorepo', private: true }),
    '/repo/HEAD/plugins/storage/sqlite/package.json': JSON.stringify({
      name: '@fixture/matbot-storage-sqlite', matbotRuntime: ['node'], exports: { '.': './src/index.ts' },
      peerDependencies: { '@matatbread/matbot-plugin-api': 'workspace:^' },
    }),
    '/repo/HEAD/plugins/storage/sqlite/src/index.ts': `export const plugin = { apiVersion: '0.4' };\n`,
  };
  const srv = await serve(files);
  try {
    const m = await materializeRemote(`${srv.origin}/repo/HEAD/plugins/storage/sqlite/`, dotPlugins, dir);
    assert.match(m.entry, /plugins[/\\]storage[/\\]sqlite[/\\]src[/\\]index\.ts$/,
      'the nested package is the package, not the repo it sits in');
    assert.equal(await readFile(m.entry, 'utf8'), files['/repo/HEAD/plugins/storage/sqlite/src/index.ts']);
    // The enclosing repo's own manifest is never consulted: the governing package.json is the nearest one.
    assert.equal(srv.log.some(r => r.path === '/repo/HEAD/package.json'), false);
    // A `workspace:` peer is not a finding — the host supplies that singleton by construction.
    assert.deepEqual(await remoteDependencyNotes(m), []);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// The one thing every fixture above erases: a REAL import of a host singleton. They write
// `import type { MatbotPluginSpec }`, which node's strip-only mode removes outright, so no test ever
// resolved a bare host import — while every real plugin imports a VALUE (`PLUGIN_API_VERSION`,
// `makeToolBox`) and so did resolve one, and failed. "A bare specifier means host-provided" needs a path
// Node can walk, and a pnpm checkout has none: workspace links live in each package's own node_modules,
// so the tree above `.plugins/` holds no `@matatbread` at all.
test('a fetched plugin imports the host singleton it peer-depends on, and gets the host copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-host-import-'));
  const dotPlugins = join(dir, '.plugins');
  const srv = await serve({
    '/p/package.json': JSON.stringify({
      name: '@fixture/matbot-imports-host', matbotRuntime: ['node'], exports: { '.': './index.ts' },
      peerDependencies: { '@matatbread/matbot-plugin-api': '*' },
    }),
    '/p/index.ts':
      `import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';\n` +
      `export const apiUrl = import.meta.resolve('@matatbread/matbot-plugin-api');\n` +
      `export const plugin = { apiVersion: PLUGIN_API_VERSION };\n`,
  });
  // Deliberately NOT imported here for comparison: `apps/cli` cannot resolve plugin-api either (it depends
  // on core), which is the whole reason the module hook's retry-against-itself could never have worked.
  const hostApi = await realpath(fileURLToPath(new URL('../../../plugin-api/', import.meta.url)));
  try {
    const m = await materializeRemote(`${srv.origin}/p/`, dotPlugins, dir);
    const mod = await import(pathToFileURL(m.entry).href) as { plugin?: { apiVersion?: unknown }; apiUrl?: string };
    assert.match(String(mod.plugin?.apiVersion), /^\d+\.\d+/, 'the value import has to actually resolve');

    // And resolve to the HOST's copy: a second one here would satisfy the import while quietly breaking
    // `instanceof` across the plugin/host seam, which is the failure the singleton boundary exists to stop.
    assert.equal(await realpath(fileURLToPath(mod.apiUrl!)), await realpath(join(hostApi, 'src', 'index.ts')));
    assert.equal(await realpath(join(dotPlugins, 'node_modules', '@matatbread', 'matbot-plugin-api')), hostApi);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// The diagnostic itself, because it was wrong in a way that sends you to the wrong file: `nextResolve`
// MERGES the context it is handed into the shared one, so the hook's retry against its own file rewrote
// the `parentURL` it later reported — every unresolvable bare import was blamed on ts-hooks.js.
test('an unresolvable bare import names the plugin file that imported it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-bare-'));
  const dotPlugins = join(dir, '.plugins');
  const srv = await serve({
    '/q/package.json': JSON.stringify({
      name: '@fixture/matbot-wants-left-pad', matbotRuntime: ['node'], exports: { '.': './index.ts' },
    }),
    '/q/index.ts': `import pad from 'left-pad-that-nothing-has';\nexport const plugin = { apiVersion: '0.4', pad };\n`,
  });
  try {
    const m = await materializeRemote(`${srv.origin}/q/`, dotPlugins, dir);
    await assert.rejects(import(pathToFileURL(m.entry).href), (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /Cannot resolve "left-pad-that-nothing-has"/);
      assert.match(msg, /imported by .*index\.ts/, `the importer must be the plugin's file, not the hook: ${msg}`);
      assert.equal(/ts-hooks\.js/.test(msg), false, `the hook is not the importer: ${msg}`);
      return true;
    });
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
