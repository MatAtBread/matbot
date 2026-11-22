import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { materializeRemote, remoteDependencyNotes, restoreRemote, discardRestore } from '../src/plugins/remote-cache.js';
import { missingPackageOf } from '../src/plugins/tools/plugin/add.js';
import { planProvision, applyProvision } from '../src/plugins/provision.js';
import { mirrorPath } from '../src/plugins/cache-layout.js';

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
    // The manifest, the entry, and what the entry's literal relative imports name (prefetched as a hint).
    // `helper.ts`'s own root-relative import is not followed: that is the module hook's to resolve.
    assert.deepEqual(srv.log.filter(r => r.status === 200).map(r => r.path), ['/a/package.json', '/a/index.ts', '/a/helper.ts']);

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

// A fetched plugin's dependencies are installed into its OWN cache directory (`plugin add` does it there
// for the reasons provision.ts states), which is the same subtree a refresh evicts. Deleting it whole made
// `reload` structurally impossible for every http plugin with a dependency: the fetch reload performs was
// the very thing that removed what add had installed, so the reloaded copy could never resolve its imports.
// The subtree has two owners, and only the fetched half is the refresh's to drop.
test('a refresh drops the fetched source and keeps what was installed into it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-provisioned-'));
  const dotPlugins = join(dir, '.plugins');
  const files = { ...FILES };
  const srv = await serve(files);
  try {
    const spec = `${srv.origin}/a/`;
    const first = await materializeRemote(spec, dotPlugins, dir);

    // What an install leaves behind, without running one.
    await mkdir(join(first.pkgRoot, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(first.pkgRoot, 'node_modules', 'left-pad', 'index.js'), 'export default 1;\n');
    await writeFile(join(first.pkgRoot, 'package-lock.json'), '{"lockfileVersion":3}');

    files['/a/index.ts'] = `export const changed = true;\n${FILES['/a/index.ts'] ?? ''}`;
    const refreshed = await materializeRemote(spec, dotPlugins, dir, /* forceRefresh */ true);

    assert.match(await readFile(refreshed.entry, 'utf8'), /^export const changed/, 'the source did come from upstream');
    assert.equal(await readFile(join(refreshed.pkgRoot, 'node_modules', 'left-pad', 'index.js'), 'utf8'),
      'export default 1;\n', 'the installed dependency survived the refresh');
    assert.equal(await readFile(join(refreshed.pkgRoot, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3}');
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// A refresh replaces the cached source, so once it has run, the copy that WAS working is no longer on
// disk: a reload whose load then fails is an outage rather than a no-op, and the only way back is a copy
// set aside before the fetch. `discardRestore` is the other half — the success path, after which there is
// nothing to go back to.
test('a refresh sets the previous copy aside, and a restore puts it back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-restore-'));
  const dotPlugins = join(dir, '.plugins');
  const files = { ...FILES };
  const srv = await serve(files);
  try {
    const spec = `${srv.origin}/a/`;
    const first = await materializeRemote(spec, dotPlugins, dir);
    const working = await readFile(first.entry, 'utf8');
    await mkdir(join(first.pkgRoot, 'node_modules', 'left-pad'), { recursive: true });

    files['/a/index.ts'] = `throw new Error('broken upstream');\n`;
    const refreshed = await materializeRemote(spec, dotPlugins, dir, /* forceRefresh */ true);
    assert.match(await readFile(refreshed.entry, 'utf8'), /broken upstream/);

    assert.equal(await restoreRemote(spec, dotPlugins), true);
    assert.equal(await readFile(first.entry, 'utf8'), working, 'the copy that was working is back');
    // The provisioning is whatever is installed now — it is not rolled back with the source.
    await access(join(first.pkgRoot, 'node_modules', 'left-pad'));

    // Nothing set aside any more: a second restore has nothing to say, and reports so rather than throwing.
    assert.equal(await restoreRemote(spec, dotPlugins), false);

    // And the warm cache is the restored copy: the memo must not still answer with the refreshed manifest.
    await srv.stop();
    const offline = await materializeRemote(spec, dotPlugins, dir);
    assert.equal(await readFile(offline.entry, 'utf8'), working);

    await discardRestore(spec, dotPlugins);
    assert.equal(await restoreRemote(spec, dotPlugins), false);
  } finally {
    await srv.stop().catch(() => {});
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
      // …nor one whose name could only be mirrored outside the cache: skipped with a warning like any other.
      exports: { '.': './index.ts' }, files: ['never-served.json', 'assets/a%2Fb.png'],
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

// ── Prefetch (issue #116) ─────────────────────────────────────────────────────────
//
// A module the hook fetches is fetched with the main thread blocked, one at a time. So a cold materialise
// mirrors what the source predictably names, concurrently, as a HINT: the hook finds those on disk, and
// fetches whatever the hint missed exactly as before.

/** A server whose handler may hold a response, answer with any status, and count what is in flight. */
function serveWith(handle: (path: string) => Promise<{ status: number; body?: string }>) {
  const log: Served[] = [];
  let inFlight = 0, peak = 0;
  const server = http.createServer((req, res) => {
    const p = req.url ?? '';
    inFlight++; peak = Math.max(peak, inFlight);
    req.on('close', () => { inFlight--; });
    void handle(p).then(({ status, body }) => {
      log.push({ path: p, status });
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(body);
    });
  });
  return new Promise<{ origin: string; log: Served[]; peak: () => number; stop: () => Promise<void> }>(resolve =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`, log, peak: () => peak,
        stop: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
      });
    }));
}

const PKG = (name: string) => JSON.stringify({ name, matbotRuntime: ['node'], exports: { '.': './index.ts' } });

test('a cold materialise prefetches what the source names, and only what Node would resolve', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-prefetch-'));
  const dotPlugins = join(dir, '.plugins');
  const files: Record<string, string> = {
    '/p/package.json': PKG('@fixture/matbot-prefetch'),
    '/p/index.ts': [
      `import { a } from './a.js';`,                        // served as .ts: the usual matbot shape
      `import { both } from './both.js';`,                  // served as .js AND .ts: the .js is the module
      `import type { T } from './type-only.js';`,           // erased by Node: never resolved, never fetched
      `import { type K } from './kept.js';`,                // survives stripping as \`import {} from\`: loads
      `const name = './computed.js'; await import(name);`,  // computed: the hook's
      `// export * from './ghost.js'`,                      // a comment: a wrong guess, costing one 404
      `import '../outside.js';`,                            // outside the package: the hook's
      `export const plugin = { a, both } as unknown as T;`,
    ].join('\n'),
    '/p/a.ts': `export { deep as a } from './lib/deep.js';\n`,
    '/p/lib/deep.ts': `export const deep = 'deep';\n`,
    '/p/both.js': `export const both = 'js';\n`,
    '/p/both.ts': `export const both = 'ts';\n`,
    '/p/type-only.ts': `export type T = unknown;\n`,
    '/p/kept.ts': `export type K = 1;\n`,
    '/p/computed.ts': `export {};\n`,
    '/outside.ts': `export {};\n`,
  };
  const srv = await serve(files);
  try {
    await materializeRemote(`${srv.origin}/p/`, dotPlugins, dir);
    const host = new URL(srv.origin).host;
    const mirrored = (rel: string) => access(join(dotPlugins, host, rel)).then(() => true, () => false);

    for (const rel of ['p/a.ts', 'p/lib/deep.ts', 'p/both.js', 'p/kept.ts']) {
      assert.ok(await mirrored(rel), `${rel} prefetched`);
    }
    assert.equal(await mirrored('p/both.ts'), false, 'the preferred candidate is the one committed');
    for (const rel of ['p/type-only.ts', 'p/computed.ts', 'outside.ts']) {
      assert.equal(await mirrored(rel), false, `${rel} left to the hook`);
    }
    const asked = srv.log.map(r => r.path);
    for (const p of ['/p/type-only.js', '/p/type-only.ts', '/p/computed.ts', '/outside.js', '/outside.ts']) {
      assert.ok(!asked.includes(p), `${p} never requested`);
    }
    assert.ok(asked.includes('/p/ghost.js'), 'the comment cost its wrong guess');

    // Nothing records a miss, so a hint that named nothing would be asked about on every boot. It is not,
    // because the prefetch runs only when the entry itself came from the network.
    srv.log.length = 0;
    await materializeRemote(`${srv.origin}/p/package.json`, dotPlugins, dir);
    assert.deepEqual(srv.log, [], 'a warm materialise still makes no requests');
  } finally {
    await srv.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

// A 500 on the preferred `.js` says nothing about whether it exists, so committing the `.ts` could pick a
// different module from the one the hook would pick, later, when the `.js` answers.
test('a prefetch commits a lower candidate only after a definite miss on the preferred one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-prefetch-500-'));
  const dotPlugins = join(dir, '.plugins');
  const body: Record<string, string> = {
    '/p/package.json': PKG('@fixture/matbot-prefetch-500'),
    '/p/index.ts': `import './flaky.js';\n`,
    '/p/flaky.ts': `export {};\n`,
  };
  const srv = await serveWith(async p => p === '/p/flaky.js' ? { status: 500 }
    : body[p] !== undefined ? { status: 200, body: body[p] } : { status: 404 });
  try {
    await materializeRemote(`${srv.origin}/p/`, dotPlugins, dir);
    await assert.rejects(access(join(dotPlugins, new URL(srv.origin).host, 'p', 'flaky.ts')), 'left to the hook');
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a prefetch that stalls is abandoned to the hook at its deadline', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-prefetch-stall-'));
  const dotPlugins = join(dir, '.plugins');
  const body: Record<string, string> = {
    '/p/package.json': PKG('@fixture/matbot-prefetch-stall'),
    '/p/index.ts': `import './quick.js';\nimport './stuck.js';\n`,
    '/p/quick.ts': `export {};\n`,
  };
  const srv = await serveWith(p => p.startsWith('/p/stuck')
    ? new Promise(() => {})
    : Promise.resolve(body[p] !== undefined ? { status: 200, body: body[p] } : { status: 404 }));
  const before = process.env['MATBOT_PREFETCH_BUDGET_MS'];
  process.env['MATBOT_PREFETCH_BUDGET_MS'] = '300';
  try {
    const started = Date.now();
    const m = await materializeRemote(`${srv.origin}/p/`, dotPlugins, dir);
    assert.ok(Date.now() - started < 5_000, 'returned at the deadline, not when the origin answered');
    assert.equal(await readFile(m.entry, 'utf8'), body['/p/index.ts']);
    const host = new URL(srv.origin).host;
    await access(join(dotPlugins, host, 'p', 'quick.ts'));
    await assert.rejects(access(join(dotPlugins, host, 'p', 'stuck.ts')));
  } finally {
    if (before === undefined) delete process.env['MATBOT_PREFETCH_BUDGET_MS'];
    else process.env['MATBOT_PREFETCH_BUDGET_MS'] = before;
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a prefetch runs concurrently, within its cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-prefetch-cap-'));
  const dotPlugins = join(dir, '.plugins');
  const N = 30;
  const body: Record<string, string> = {
    '/p/package.json': PKG('@fixture/matbot-prefetch-cap'),
    '/p/index.ts': Array.from({ length: N }, (_, i) => `import './m${i}.js';`).join('\n'),
  };
  for (let i = 0; i < N; i++) body[`/p/m${i}.ts`] = `export const m${i} = ${i};\n`;
  // Held briefly so overlapping requests are actually in flight together.
  const srv = await serveWith(p => new Promise(done => setTimeout(() =>
    done(body[p] !== undefined ? { status: 200, body: body[p] } : { status: 404 }), 20)));
  try {
    await materializeRemote(`${srv.origin}/p/`, dotPlugins, dir);
    const host = new URL(srv.origin).host;
    for (let i = 0; i < N; i++) await access(join(dotPlugins, host, 'p', `m${i}.ts`));
    assert.ok(srv.peak() > 1, `concurrent (peak ${srv.peak()})`);
    assert.ok(srv.peak() <= 8, `capped (peak ${srv.peak()})`);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// The mirror maps a plugin package's URLs onto paths, and two spellings survive URL parsing that would put
// one outside `.plugins/<host>/`. Dot segments do not, encoded or not — the parser has already resolved them.
test('a mirrored path stays inside its host\'s directory', () => {
  const dotPlugins = join(tmpdir(), '.plugins');
  assert.equal(mirrorPath('https://h.example/a/%2e%2e/%2E%2e/x.ts', dotPlugins), join(dotPlugins, 'h.example', 'x.ts'));
  assert.equal(mirrorPath('https://h.example/a/b%40c.ts', dotPlugins), join(dotPlugins, 'h.example', 'a', 'b@c.ts'));
  assert.throws(() => mirrorPath('https://h.example/a/..%2F..%2F..%2Fx.ts', dotPlugins), /outside the plugin cache/);
  assert.throws(() => mirrorPath('https://h.example/a/..%5c..%5cx.ts', dotPlugins), /outside the plugin cache/);
  assert.throws(() => mirrorPath('http://../x.ts', dotPlugins), /outside the plugin cache/, 'a host of `..` parses');
  assert.throws(() => mirrorPath('http://.restore/x.ts', dotPlugins), /outside the plugin cache/, 'and so does bookkeeping');
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
    assert.match(notes, /installed into its cache directory when it is added/);
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
// fetches one package's files and resolves bare imports against the host. The fragment is refused since
// 0.5.0; this is the mechanism under the `github:owner/repo/sub` form that replaces it.
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
      // The `plugin` tool reads this message to name the package it should OFFER to install. The two
      // live in different packages with nothing but a regex between them, and they silently disagreed:
      // the tool matched Node's `Cannot find package 'x'`, while every http plugin — the only route the
      // branch exists for — arrives here with the hook's `Cannot resolve "x"` instead, so the tailored
      // remedy was unreachable and the raw error was surfaced in its place.
      assert.equal(missingPackageOf(e), 'left-pad-that-nothing-has',
        `the plugin tool must recover the package name from this exact error: ${msg}`);
      return true;
    });
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// The other wording, and the exclusion. Node's own phrasing reaches the tool whenever the importer is
// NOT in the cache tree (`resolveAsHost` rethrows the original), so both must be read; a relative
// specifier is a broken internal import, which no amount of installing fixes.
test('a missing package is recovered from either wording, and a relative import is not one', () => {
  const nodeOwn = Object.assign(new Error(`Cannot find package 'imapflow' imported from /p/index.ts`),
    { code: 'ERR_MODULE_NOT_FOUND' });
  const hook = Object.assign(new Error(`Cannot resolve "imapflow" imported by file:///p/.plugins/h/x/index.ts: a plugin fetched over http brings its own files only`),
    { code: 'ERR_MODULE_NOT_FOUND' });
  const relative = Object.assign(new Error(`Cannot find module './helpers.js'`), { code: 'ERR_MODULE_NOT_FOUND' });

  assert.equal(missingPackageOf(nodeOwn), 'imapflow');
  assert.equal(missingPackageOf(hook), 'imapflow');
  assert.equal(missingPackageOf(relative), undefined);
  assert.equal(missingPackageOf(new Error('something else entirely')), undefined);
});

// The whole point of the route, end to end: a fetched plugin declaring a registry dependency could not
// activate, because a source-fetch brings one package's files and no dependency graph. The dependencies
// are installed into the plugin's OWN cache root — not the user's project, where `pnpm add` refuses at a
// workspace root outright and otherwise writes a fetched plugin's dependencies into a tracked manifest,
// and not the shared link farm, where an install would prune the host singletons as extraneous. The cache
// root sits earlier in the resolution walk-up than the farm, so what lands there is reachable from this
// plugin and invisible to everything else, and `rm -rf` on it takes the dependencies with it.
test('a fetched plugin\'s dependencies install into its cache root and make it load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-deps-'));
  const dotPlugins = join(dir, '.plugins');
  const srv = await serve({
    '/p/package.json': JSON.stringify({
      name: '@fixture/matbot-needs-ms', version: '1.0.0', type: 'module',
      matbotRuntime: ['node'], exports: { '.': './index.ts' },
      dependencies: { ms: '2.1.3' },
      peerDependencies: { '@matatbread/matbot-plugin-api': '^0.4.0' },
    }),
    '/p/index.ts':
      `import ms from 'ms';\n` +
      `import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';\n` +
      `export const plugin = { apiVersion: PLUGIN_API_VERSION, ms: ms('1h') };\n`,
  });
  try {
    const m = await materializeRemote(`${srv.origin}/p/`, dotPlugins, dir);

    // The failure being fixed, asserted rather than assumed — and it is what `plugin add` reads to decide
    // to offer the install at all.
    await assert.rejects(import(pathToFileURL(m.entry).href), (e: unknown) => {
      assert.equal(missingPackageOf(e), 'ms');
      return true;
    });

    const plan = await planProvision(m.pkgRoot);
    assert.deepEqual(plan.packages, ['ms@2.1.3']);
    const { linked } = await applyProvision(plan);
    assert.ok(linked.includes('@matatbread/matbot-plugin-api'));

    // A fresh URL: the earlier failed resolution must not be what this re-reads.
    const mod = await import(`${pathToFileURL(m.entry).href}?installed=1`) as { plugin: { ms: number } };
    assert.equal(mod.plugin.ms, 3600000, 'the dependency resolves from the cache root');
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// A directory standing where the entry goes is not the entry. Returned as one, it failed later as a
// directory import with nothing to say why; refused here, the failure names the path.
test('a directory at the entry\'s cache path is not taken for the cached entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-cache-'));
  const dotPlugins = join(dir, '.plugins');
  const srv = await serve({
    '/y/package.json': JSON.stringify({ name: '@fixture/matbot-remote-y', matbotRuntime: ['node'], exports: './main.js' }),
    '/y/main.js': `export const plugin = { apiVersion: '0.4' };\n`,
  });
  try {
    await mkdir(join(dotPlugins, new URL(srv.origin).host, 'y', 'main.js'), { recursive: true });
    await assert.rejects(materializeRemote(`${srv.origin}/y/`, dotPlugins, dir), /EISDIR|main\.js/);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// A directory standing where the entry goes is not the entry. Returned as one, it failed later as a
// directory import with nothing to say why; refused here, the failure names the path.
test('a directory at the entry\'s cache path is not taken for the cached entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-remote-cache-'));
  const dotPlugins = join(dir, '.plugins');
  const srv = await serve({
    '/y/package.json': JSON.stringify({ name: '@fixture/matbot-remote-y', matbotRuntime: ['node'], exports: './main.js' }),
    '/y/main.js': `export const plugin = { apiVersion: '0.4' };\n`,
  });
  try {
    await mkdir(join(dotPlugins, new URL(srv.origin).host, 'y', 'main.js'), { recursive: true });
    await assert.rejects(materializeRemote(`${srv.origin}/y/`, dotPlugins, dir), /EISDIR.*main\.js/);
  } finally {
    await srv.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
