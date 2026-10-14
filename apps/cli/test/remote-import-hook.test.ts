import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
// @ts-expect-error — the module hook is plain .js by necessity: it IS the type stripper, so it cannot
// rely on it. It has no declarations, and adding them would only restate the JSDoc.
import { resolveFetched, cacheLocation, loadStored, bareAnchor } from '../remote-loader.js';

// A fetched plugin's module graph used to be predicted by three regexes over the source and fetched ahead
// of time. Node's resolver does it properly, so the fetching moved into the module hook — which is what
// these test. Each case below is something the lexer got wrong, not a hypothetical.

interface Served { path: string; status: number }

function serve(files: Record<string, string>, redirects: Record<string, string> = {}): Promise<{ origin: string; log: Served[]; stop: () => Promise<void> }> {
  const log: Served[] = [];
  const server = http.createServer((req, res) => {
    const to = redirects[req.url ?? ''];
    if (to !== undefined) { log.push({ path: req.url ?? '', status: 302 }); res.writeHead(302, { location: to }); res.end(); return; }
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
  // …and a dot-directory in the cache is matbot's own bookkeeping, though a dot makes it look like a host.
  assert.equal(cacheLocation('file:///home/me/proj/.plugins/.urls/0a1b.src'), undefined);
  assert.equal(cacheLocation('file:///home/me/proj/.plugins/.restore/example.com/p/index.ts'), undefined);
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

// Only an import with no extension is a question about which file was meant. `data.json` names itself: it
// was treated as extensionless by one of three lists, and asked the origin for `data.json.ts` and
// `data.json/index.ts` besides.
test('a URL with a module extension other than .js names exactly one file', async () => {
  const srv = await serve({});
  const { parent, cleanup } = await cacheTree(new URL(srv.origin).host);
  try {
    await assert.rejects(resolveFetched('/p/data.json', parent) as Promise<string>);
    assert.deepEqual(srv.log.map(r => r.path), ['/p/data.json']);
  } finally {
    await srv.stop();
    await cleanup();
  }
});

// Dropped from both buckets by the lexer, then failed at load. A third-party dependency expressed as a URL
// is the documented way to have one on this route, so it had to actually work. It is not mirrored: the module
// keeps its URL, as it would in a browser, and nothing is written under the other host's name.
test('an absolute URL import is fetched, including from another host, and keeps its URL', async () => {
  const other = await serve({ '/lib/thing.ts': 'export const thing = "other-host";\n' });
  const srv = await serve({});
  const { dotPlugins, parent, cleanup } = await cacheTree(new URL(srv.origin).host);
  try {
    const url = await resolveFetched(`${other.origin}/lib/thing.ts`, parent) as string;
    assert.equal(url, `${other.origin}/lib/thing.ts`);
    assert.equal(loadStored(url), 'export const thing = "other-host";\n');
    assert.equal(existsSync(join(dotPlugins, new URL(other.origin).host)), false);
  } finally {
    await srv.stop();
    await other.stop();
    await cleanup();
  }
});

// Issue #89. A URL may be a module AND the parent of others, and every npm CDN serves a bare package that
// way: `https://esm.sh/ms@2.1.3` re-exports `/ms@2.1.3/es2022/ms.mjs`. Mirrored, the first took as a file the
// name the second needs as a directory, and `mkdir` failed with ENOTDIR. As URLs, there is nothing to collide
// — including `chart.js` beside `chart.js/auto`, which no rule over a mirrored path could tell from a file.
test('a module imported by URL resolves its own imports against that URL, whatever the path looks like', async () => {
  const files = {
    '/ms@2.1.3': 'export { default } from "/ms@2.1.3/es2022/ms.mjs";\n',
    '/ms@2.1.3/es2022/ms.mjs': 'export default () => "1m";\n',
    '/chart.js': 'export * from "./chart.js/auto";\n',
    '/chart.js/auto': 'export default 1;\n',
  };
  const srv = await serve(files);
  const { parent, cleanup } = await cacheTree('plugins.example.com');
  try {
    const ms = await resolveFetched(`${srv.origin}/ms@2.1.3`, parent) as string;
    assert.equal(ms, `${srv.origin}/ms@2.1.3`);
    assert.equal(await resolveFetched('/ms@2.1.3/es2022/ms.mjs', ms), `${srv.origin}/ms@2.1.3/es2022/ms.mjs`);
    const chart = await resolveFetched(`${srv.origin}/chart.js`, parent) as string;
    assert.equal(await resolveFetched('./chart.js/auto', chart), `${srv.origin}/chart.js/auto`);
    for (const path of Object.keys(files)) assert.equal(loadStored(`${srv.origin}${path}`), files[path as keyof typeof files]);

    // Warm, the same answers and nothing asked.
    srv.log.length = 0;
    assert.equal(await resolveFetched(`${srv.origin}/ms@2.1.3`, parent), ms);
    assert.equal(await resolveFetched('/ms@2.1.3/es2022/ms.mjs', ms), `${srv.origin}/ms@2.1.3/es2022/ms.mjs`);
    assert.deepEqual(srv.log, []);
  } finally {
    await srv.stop();
    await cleanup();
  }
});

// unpkg answers a bare package by redirect. Cached under the URL asked for, the module's relative imports
// were rebuilt against the wrong directory; the module is the URL that answered.
test('a redirected URL import is the module that answered it', async () => {
  const srv = await serve(
    { '/lit@3.3.3/index.js?module=': 'export * from "./part.js?module";\n', '/lit@3.3.3/part.js?module': 'export const part = 1;\n' },
    { '/lit@3?module': '/lit@3.3.3/index.js?module=' },
  );
  const { parent, cleanup } = await cacheTree('plugins.example.com');
  try {
    const lit = await resolveFetched(`${srv.origin}/lit@3?module`, parent) as string;
    assert.equal(lit, `${srv.origin}/lit@3.3.3/index.js?module=`);
    assert.equal(await resolveFetched('./part.js?module', lit), `${srv.origin}/lit@3.3.3/part.js?module`);

    // Warm, both spellings are that one module, and the redirect is not asked again.
    srv.log.length = 0;
    assert.equal(await resolveFetched(`${srv.origin}/lit@3?module`, parent), lit);
    assert.equal(await resolveFetched(lit, parent), lit);
    assert.deepEqual(srv.log, []);
  } finally {
    await srv.stop();
    await cleanup();
  }
});

// The mirror dropped the query, so `?bundle` and `?dev` of one path were one file — whichever came first.
test('the query is part of a URL import\'s name', async () => {
  const srv = await serve({ '/x?a': 'export const which = "a";\n', '/x?b': 'export const which = "b";\n' });
  const { parent, cleanup } = await cacheTree('plugins.example.com');
  try {
    for (const q of ['a', 'b']) {
      const url = await resolveFetched(`${srv.origin}/x?${q}`, parent) as string;
      assert.equal(loadStored(url), `export const which = "${q}";\n`);
    }
  } finally {
    await srv.stop();
    await cleanup();
  }
});

// `%2F` decodes to a separator the URL never had, so a path built from it could climb out of the cache.
// By URL, nothing is built from the path at all; in the mirror, it is refused.
test('an encoded separator can name nothing outside the cache', async () => {
  const srv = await serve({ '/..%2F..%2F..%2Fescaped.mjs': 'export default 1;\n' });
  const { dotPlugins, parent, cleanup } = await cacheTree(new URL(srv.origin).host);
  try {
    const url = await resolveFetched(`${srv.origin}/..%2F..%2F..%2Fescaped.mjs`, parent) as string;
    assert.equal(loadStored(url), 'export default 1;\n');
    assert.equal(existsSync(join(dotPlugins, '..', 'escaped.mjs')), false);

    await assert.rejects(resolveFetched('./..%2F..%2F..%2Fescaped.mjs', parent) as Promise<string>, /outside the plugin cache/);
    assert.equal(existsSync(join(dotPlugins, '..', 'escaped.mjs')), false);
  } finally {
    await srv.stop();
    await cleanup();
  }
});

// A cache written before URL imports had their own store mirrored them. An install that upgrades must not
// have to fetch them again — with the CDN unreachable it would lose every plugin that has one.
test('a URL import the mirror cached before is still found, with no network', async () => {
  const srv = await serve({});
  const host = new URL(srv.origin).host;
  const { dotPlugins, parent, cleanup } = await cacheTree('plugins.example.com');
  try {
    await mkdir(join(dotPlugins, host, 'npm', 'x@1'), { recursive: true });
    await writeFile(join(dotPlugins, host, 'npm', 'x@1', '+esm'), 'export default 1;\n');
    const url = await resolveFetched(`${srv.origin}/npm/x@1/+esm`, parent) as string;
    assert.equal(url, `${srv.origin}/npm/x@1/+esm`);
    assert.equal(loadStored(url), 'export default 1;\n');
    assert.deepEqual(srv.log, []);
    // Served from where it is: an upgraded cache this process cannot write (a read-only image) answers too.
    assert.equal(existsSync(join(dotPlugins, '.urls')), false);

    // Not for a query, which the mirror dropped: the file there may be another query's module.
    await assert.rejects(resolveFetched(`${srv.origin}/npm/x@1/+esm?dev`, parent) as Promise<string>);
  } finally {
    await srv.stop();
    await cleanup();
  }
});

// A plugin's own files load as `file:`; the same file imported by its URL would be a second copy of it, with
// its own module state. Refused, naming the import that reaches the one copy — before anything is fetched.
test('a file of a fetched plugin imported by URL is refused, naming the import that reaches it', async () => {
  const srv = await serve({ '/p/index.ts': 'export const entry = 1;\n', '/p/lib/x.ts': 'export {};\n' });
  const host = new URL(srv.origin).host;
  const { dotPlugins, parent, cleanup } = await cacheTree(host);
  try {
    await writeFile(join(dotPlugins, host, 'p', 'package.json'), JSON.stringify({ name: '@fixture/p' }));
    for (const url of [`${srv.origin}/p/index.ts`, `${srv.origin}/p/lib/x.ts`]) {
      await assert.rejects(resolveFetched(url, parent) as Promise<string>,
        (e: unknown) => e instanceof Error && /is a file of the fetched plugin "@fixture\/p"/.test(e.message)
          && /by its package name \("@fixture\/p"\)/.test(e.message));
    }
    assert.deepEqual(srv.log, []);
    assert.match(await resolveFetched(`${srv.origin}/elsewhere.mjs`, parent).catch((e: Error) => e.message) as string,
      /was not found/, 'a URL outside the package is an ordinary URL import');
  } finally {
    await srv.stop();
    await cleanup();
  }
});

// Fetched at exactly its URL, as a browser fetches it — a plugin's own relative `./x.js` is the case that tries
// `x.ts`. A miss says which URL to write instead.
test('a URL import of a .js that is served as .ts says which URL to import', async () => {
  const other = await serve({ '/lib/x.ts': 'export {};\n' });
  const { parent, cleanup } = await cacheTree('plugins.example.com');
  try {
    await assert.rejects(resolveFetched(`${other.origin}/lib/x.js`, parent) as Promise<string>,
      (e: unknown) => e instanceof Error && e.message.includes(`import "${other.origin}/lib/x.ts"`));
  } finally {
    await other.stop();
    await cleanup();
  }
});

test('a bare import from a module imported by URL is looked up from the cache', async () => {
  const srv = await serve({ '/m.mjs': 'export {};\n' });
  const { dotPlugins, parent, cleanup } = await cacheTree('plugins.example.com');
  try {
    const url = await resolveFetched(`${srv.origin}/m.mjs`, parent) as string;
    assert.equal(await resolveFetched('left-pad', url), undefined, 'still not the hook\'s business…');
    assert.equal(bareAnchor(url), pathToFileURL(join(dotPlugins, '.urls', 'importer.js')).href, '…but anchored');
  } finally {
    await srv.stop();
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
