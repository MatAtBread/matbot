import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
// @ts-expect-error — the module hook is plain .js by necessity: it IS the type stripper, so it cannot
// rely on it. It has no declarations, and adding them would only restate the JSDoc.
import { resolveFetched, cacheLocation } from '../remote-loader.js';

// A fetched plugin's module graph used to be predicted by three regexes over the source and fetched ahead
// of time. Node's resolver does it properly, so the fetching moved into the module hook — which is what
// these test. Each case below is something the lexer got wrong, not a hypothetical.

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
    resolve({ origin: `http://127.0.0.1:${port}`, log, stop: () => new Promise<void>(d => server.close(() => d())) });
  }));
}

/** A cache tree with one module already in it, as a materialise would leave it. */
async function cacheTree(host: string, scheme = 'http:'): Promise<{ dotPlugins: string; parent: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-hook-'));
  const dotPlugins = join(dir, '.plugins');
  await mkdir(join(dotPlugins, host, 'p'), { recursive: true });
  await writeFile(join(dotPlugins, host, '.origin'), scheme);
  await writeFile(join(dotPlugins, host, 'p', 'index.ts'), 'export const entry = 1;\n');
  return {
    dotPlugins,
    parent: new URL(`file://${join(dotPlugins, host, 'p', 'index.ts')}`).href,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('a cache location is recognised from the tree alone, and nothing else is', () => {
  // Nothing is configured into the hook: it runs on the module-customization thread, registered before
  // matbot.yaml has even been found, so the tree's own layout has to be the whole signal.
  const at = cacheLocation('file:///home/me/proj/.plugins/raw.githubusercontent.com/o/r/HEAD/p/index.ts');
  assert.equal(at?.host, 'raw.githubusercontent.com');
  assert.equal(at?.rel, 'o/r/HEAD/p/index.ts');
  assert.equal(cacheLocation('file:///home/me/proj/.plugins/127.0.0.1:8080/p/x.ts')?.host, '127.0.0.1:8080');

  // A directory called `.plugins` whose child is not host-shaped is somebody else's directory.
  assert.equal(cacheLocation('file:///home/me/proj/.plugins/notahost/x.ts'), undefined);
  assert.equal(cacheLocation('file:///home/me/proj/src/index.ts'), undefined);
  assert.equal(cacheLocation('node:fs'), undefined);
  // The root entry point resolves with no parent at all — called on every single launch.
  assert.equal(cacheLocation(undefined), undefined);
});

test('a relative import is fetched on demand, at the .ts the .js specifier means', async () => {
  const srv = await serve({ '/p/sibling.ts': 'export const fromSibling = 1;\n' });
  const host = new URL(srv.origin).host;
  const { dotPlugins, parent, cleanup } = await cacheTree(host);
  try {
    const url = await resolveFetched('./sibling.js', parent) as string;
    assert.match(url, /sibling\.ts$/, 'the `.js` specifier resolves to the `.ts` that exists upstream');
    assert.equal(await readFile(new URL(url), 'utf8'), 'export const fromSibling = 1;\n');
    assert.deepEqual(srv.log.map(r => `${r.status} ${r.path}`), ['404 /p/sibling.js', '200 /p/sibling.ts']);

    // Second time: on disk, so nothing is asked. This is what keeps a warm boot at zero requests.
    srv.log.length = 0;
    assert.equal(await resolveFetched('./sibling.js', parent), url);
    assert.deepEqual(srv.log, []);
    void dotPlugins;
  } finally {
    await srv.stop();
    await cleanup();
  }
});

// The lexer filed this as a package named '', whose symlink path collapsed to the farm's own directory —
// so it "resolved", and was skipped. It is what esm.sh rewrites every dependency import to.
test('a root-relative import resolves against the origin, not the filesystem root', async () => {
  const srv = await serve({ '/ms@2.1.3/es2022/ms.mjs': 'export default () => "1m";\n' });
  const host = new URL(srv.origin).host;
  const { parent, cleanup } = await cacheTree(host);
  try {
    const url = await resolveFetched('/ms@2.1.3/es2022/ms.mjs', parent) as string;
    assert.match(url, /\.plugins[/\\]127\.0\.0\.1:\d+[/\\]ms@2\.1\.3[/\\]es2022[/\\]ms\.mjs$/);
    assert.equal(await readFile(new URL(url), 'utf8'), 'export default () => "1m";\n');
  } finally {
    await srv.stop();
    await cleanup();
  }
});

// Dropped from both buckets by the lexer, then failed at load. A third-party dependency expressed as a URL
// is the documented way to have one on this route, so it had to actually work.
test('an absolute URL import is fetched, including from another host', async () => {
  const other = await serve({ '/lib/thing.ts': 'export const thing = "other-host";\n' });
  const srv = await serve({});
  const { parent, cleanup } = await cacheTree(new URL(srv.origin).host);
  try {
    const url = await resolveFetched(`${other.origin}/lib/thing.ts`, parent) as string;
    assert.match(url, new RegExp(`\\.plugins[/\\\\]${new URL(other.origin).host.replace('.', '\\.')}[/\\\\]lib[/\\\\]thing\\.ts$`));
    assert.equal(await readFile(new URL(url), 'utf8'), 'export const thing = "other-host";\n');
    // …and the other host's scheme is recorded, so a later boot can reconstruct ITS relative imports.
    assert.equal(await readFile(new URL(url.replace(/lib[/\\]thing\.ts$/, '.origin')), 'utf8'), 'http:');
  } finally {
    await srv.stop();
    await other.stop();
    await cleanup();
  }
});

test('a bare specifier is not the hook\'s business, and node: never is', async () => {
  const { parent, cleanup } = await cacheTree('example.com');
  try {
    assert.equal(await resolveFetched('@matatbread/matbot-plugin-api', parent), undefined);
    assert.equal(await resolveFetched('left-pad', parent), undefined);
    assert.equal(await resolveFetched('node:fs', parent), undefined);
    // and a module that is not in a cache tree at all is never touched
    assert.equal(await resolveFetched('./x.js', 'file:///somewhere/else/index.ts'), undefined);
  } finally {
    await cleanup();
  }
});

test('an import that exists nowhere upstream says so, naming the importer', async () => {
  const srv = await serve({});
  const { parent, cleanup } = await cacheTree(new URL(srv.origin).host);
  try {
    await assert.rejects(
      resolveFetched('./missing.js', parent) as Promise<string>,
      (e: unknown) => e instanceof Error && /Cannot fetch "\.\/missing\.js"/.test(e.message)
        && /index\.ts/.test(e.message) && /was not found at/.test(e.message),
    );
  } finally {
    await srv.stop();
    await cleanup();
  }
});

test('with the server gone, a mirrored import still resolves and a missing one blames the network', async () => {
  const srv = await serve({ '/p/sibling.ts': 'export const fromSibling = 1;\n' });
  const host = new URL(srv.origin).host;
  const { parent, cleanup } = await cacheTree(host);
  try {
    await resolveFetched('./sibling.js', parent);      // warm it
    await srv.stop();
    assert.match(await resolveFetched('./sibling.js', parent) as string, /sibling\.ts$/);
    await assert.rejects(
      resolveFetched('./never-fetched.js', parent) as Promise<string>,
      (e: unknown) => e instanceof Error && /could not be reached/.test(e.message),
    );
  } finally {
    await srv.stop().catch(() => {});
    await cleanup();
  }
});
