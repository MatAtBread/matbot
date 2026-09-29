import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

// A fetched plugin's own imports are fetched as Node asks for them. The hooks now run in-thread and answer
// synchronously, so the fetch runs on a worker they wait on; this drives that through a real `import()`,
// which remote-import-hook.test.ts (calling `resolveFetched` directly) does not.
//
// The origin runs on a worker too: this thread is blocked while a fetch is in flight, so a server on it
// could never answer. Nor could it under `module.register()` since Node 24.12.
const ORIGIN = `
const { parentPort, workerData } = require('node:worker_threads');
const server = require('node:http').createServer((req, res) => {
  parentPort.postMessage({ asked: req.url });
  const body = workerData.files[req.url];
  if (body === undefined) { res.statusCode = 404; res.end(); return; }
  res.end(body);
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ origin: 'http://127.0.0.1:' + server.address().port }));
parentPort.on('message', () => parentPort.postMessage({ flushed: true }));
`;

async function serve(files: Record<string, string>) {
  const asked: string[] = [];
  let flushed: (() => void) | undefined;
  const worker = new Worker(ORIGIN, { eval: true, workerData: { files } });
  const origin = await new Promise<string>((resolve, reject) => {
    worker.on('message', (m: { asked?: string; origin?: string; flushed?: true }) => {
      if (m.asked !== undefined) asked.push(m.asked);
      if (m.origin !== undefined) resolve(m.origin);
      if (m.flushed) flushed?.();
    });
    worker.once('error', reject);
  });
  // The request log arrives as messages, which queue while this thread is blocked on a fetch; a reply sent
  // after them all is how to know they have landed.
  const requests = async () => {
    await new Promise<void>(resolve => { flushed = resolve; worker.postMessage('flush'); });
    return asked;
  };
  return { origin, requests, stop: () => worker.terminate() };
}

test('a fetched plugin\'s imports are fetched on demand through the in-thread hooks', { timeout: 30_000 }, async () => {
  const srv = await serve({
    '/p/lib/deep.ts': `export { leaf } from '../leaf.js';\nexport const deep: string = 'deep';\n`,
    '/p/leaf.ts': `export const leaf: string = 'leaf';\n`,
  });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'matbot-in-thread-fetch-')));
  const hostDir = join(dir, '.plugins', new URL(srv.origin).host);
  try {
    // What a materialise leaves behind: the entry, and the scheme its host was fetched over.
    mkdirSync(join(hostDir, 'p'), { recursive: true });
    writeFileSync(join(hostDir, '.origin'), 'http:');
    writeFileSync(join(hostDir, 'p', 'index.ts'), `export { deep, leaf } from './lib/deep.js';\n`);

    const mod = await import(pathToFileURL(join(hostDir, 'p', 'index.ts')).href);
    assert.equal(mod.deep, 'deep');
    assert.equal(mod.leaf, 'leaf');
    assert.ok(existsSync(join(hostDir, 'p', 'lib', 'deep.ts')), 'fetched into the mirrored tree');
    assert.ok(existsSync(join(hostDir, 'p', 'leaf.ts')));
    // Each import asked for its preferred `.js` name, then the `.ts` that exists, and nothing else.
    assert.deepEqual(await srv.requests(), ['/p/lib/deep.js', '/p/lib/deep.ts', '/p/leaf.js', '/p/leaf.ts']);
  } finally {
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fetched plugin\'s import that nothing serves fails with the file that asked for it', { timeout: 30_000 }, async () => {
  const srv = await serve({});
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'matbot-in-thread-fetch-')));
  const hostDir = join(dir, '.plugins', new URL(srv.origin).host);
  try {
    mkdirSync(join(hostDir, 'p'), { recursive: true });
    writeFileSync(join(hostDir, '.origin'), 'http:');
    writeFileSync(join(hostDir, 'p', 'index.ts'), `export * from './gone.js';\n`);
    await assert.rejects(import(pathToFileURL(join(hostDir, 'p', 'index.ts')).href), (e: NodeJS.ErrnoException) => {
      assert.equal(e.code, 'ERR_MODULE_NOT_FOUND');
      assert.match(e.message, /Cannot fetch "\.\/gone\.js" imported by .*\/p\/index\.ts/);
      return true;
    });
  } finally {
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The in-thread hooks see `require()` too, which `register()`'s never did. From inside a fetched tree, a
// `/…` import means a path on the plugin's ORIGIN; a `require('/…')` means a file on this disk, and
// tool-plugin's dependency notes make exactly that call. Reading it as the former made it a fetch.
test('a require of an absolute path from inside a fetched tree reads the file, fetching nothing', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'matbot-in-thread-require-')));
  const tree = join(dir, '.plugins', '127.0.0.1:9', 'a');   // port 9 (discard): nothing would answer
  try {
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(dir, 'beside.json'), JSON.stringify({ name: 'beside' }));
    const req = createRequire(join(tree, '_'));
    assert.equal(req(join(dir, 'beside.json')).name, 'beside');
    assert.equal(req.resolve(join(dir, 'beside.json')), join(dir, 'beside.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
