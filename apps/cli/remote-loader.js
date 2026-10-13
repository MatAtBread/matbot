// On-demand fetching for a plugin fetched over http, driven by Node's module resolution rather than by
// a regex scan ahead of it.
//
// WHY THE SCAN HAD TO GO. `materializeRemote` used to lex every module with three regexes, queue what
// looked like a relative import, and fetch the graph before handing the entry to Node. A lexer guessing
// at a module graph gets three things wrong that a resolver cannot:
//
//   - `import(variable)` is invisible. A computed dynamic import was never fetched.
//   - a root-relative specifier has no package name. `/ms@2.1.3/es2022/ms.mjs` — what esm.sh rewrites
//     imports to — was filed as a package called `''`, whose symlink path collapsed to the farm's own
//     directory, so it "resolved" and was skipped.
//   - an absolute URL import was dropped from both buckets and then failed at load.
//
// Node already walks the graph correctly, lazily, and including dynamic imports. So resolution is where
// the fetching belongs: when a module inside `.plugins/` asks for something we do not have, fetch it,
// write it where its identity says it lives, and hand back the file: URL.
//
// IDENTITY STAYS `file:`. A fetched plugin is a real package on disk — that is what lets `import.meta.url`
// work with `createRequire`/`fileURLToPath`, lets `discover_local` walk the tree and reconstruct each
// package's URL, lets docker-bash mount `projectRoot` read-only so the model can read what it fetched, and
// lets a CommonJS dependency load at all. The URL is where a file CAME from; the path is what it IS.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, MessageChannel, receiveMessageOnPort, isMainThread, workerData, parentPort } from 'node:worker_threads';
import path from 'node:path';

const CACHE_DIR = '.plugins';

// Per request, headers and body together. The worker reads the same value, inheriting this environment.
const FETCH_TIMEOUT_MS = Number(process.env.MATBOT_FETCH_TIMEOUT_MS) || 30_000;

// The scheme is not recoverable from the mirrored path — `.plugins/<host>/<path…>` deliberately keys on
// host so one origin is one directory — so each host records its own. Absent means https, which is what
// every cache written before this file existed came from.
//
// Written by plugins/tool-plugin/src/remote-cache.ts, which cannot import the name from here (`plugins/`
// may not depend on `apps/`) — keep the two in sync, as with the `mbfresh` stamp shared with core.
const ORIGIN_FILE = '.origin';

const schemeByHostDir = new Map();

function schemeFor(hostDir) {
  const cached = schemeByHostDir.get(hostDir);
  if (cached !== undefined) return cached;
  let scheme = 'https:';
  try { scheme = readFileSync(path.join(hostDir, ORIGIN_FILE), 'utf8').trim() || 'https:'; }
  catch { /* pre-existing cache, or a host we have not recorded — https */ }
  schemeByHostDir.set(hostDir, scheme);
  return scheme;
}

/** Record which scheme a host was fetched over, so a later boot can reconstruct its URLs. */
export async function recordOrigin(dotPlugins, url) {
  const u = new URL(url);
  const hostDir = path.join(dotPlugins, u.host);
  await mkdir(hostDir, { recursive: true });
  await writeFile(path.join(hostDir, ORIGIN_FILE), u.protocol, 'utf8');
  schemeByHostDir.set(hostDir, u.protocol);
}

/**
 * Locate a file inside a fetched-plugin tree: `…/.plugins/<host>/<rel…>`.
 *
 * The tree's own layout is the whole configuration — nothing has to be passed in from the host, which
 * matters because this runs on the module-customization thread, registered before `matbot.yaml` has even
 * been found. `<host>` must look like one (a dot, or a port) so an unrelated directory called `.plugins`
 * cannot be mistaken for a cache.
 */
export function cacheLocation(fileUrl) {
  // The root entry point resolves with no parent at all, so this is called with undefined on every launch.
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file:')) return undefined;
  let filePath;
  try { filePath = fileURLToPath(fileUrl.split('?')[0]); } catch { return undefined; }

  const parts = filePath.split(path.sep);
  const at = parts.lastIndexOf(CACHE_DIR);
  if (at === -1 || at + 1 >= parts.length) return undefined;
  const host = parts[at + 1];
  if (!/\.|:\d+$/.test(host)) return undefined;

  return {
    dotPlugins: parts.slice(0, at + 1).join(path.sep),
    hostDir:    parts.slice(0, at + 2).join(path.sep),
    host,
    rel:        parts.slice(at + 2).join('/'),
  };
}

// What Node loads by extension. A path ending in one of these is mirrored under its own name.
const MODULE_EXT = /\.(?:ts|mts|cts|js|mjs|cjs|json|wasm)$/;

/**
 * Where a URL's module lives once fetched — the same mapping `remote-cache.ts` mirrors with.
 *
 * A URL space lets one path be both a document and the prefix of others; a directory tree does not. And
 * that is the shape every npm CDN serves a bare package in: `https://esm.sh/ms@2.1.3` is a module whose own
 * imports live under `/ms@2.1.3/…`. Mirrored verbatim it took, as a FILE, the name its children need as a
 * directory, and the second fetch died in `mkdir` with ENOTDIR.
 *
 * So a path with no module extension is given one: `ms@2.1.3.mjs`, beside `ms@2.1.3/`. Beside rather than
 * an index inside, because the file then stays in the directory its URL is in — a relative import from it
 * reconstructs the right URL with nothing to map back, and `import.meta.url` keeps the same neighbours.
 * `.mjs` because a module reached by URL is an ES module, whatever its path says. It shares the name with a
 * URL that really does end `.mjs`; a server offering both is offering one module, and one copy of it is
 * the better outcome.
 *
 * A path that HAS a module extension stays where it is, because a plugin's own tree has to remain a real
 * package on disk. That leaves the one case no rule over the URL alone can settle: a name that is a file
 * by its extension and a directory by use (`https://esm.sh/chart.js` beside `https://esm.sh/chart.js/auto`),
 * which nothing distinguishes from an `index.js`. `store` says so rather than surfacing the errno. A pinned
 * `chart.js@4.5.1` has no extension, so it is unaffected.
 */
function urlToCachePath(url, dotPlugins) {
  const u = new URL(url);
  const pathname = decodeURIComponent(u.pathname);
  const leaf = MODULE_EXT.test(pathname) ? '' : pathname.endsWith('/') ? 'index.mjs' : '.mjs';
  return path.join(dotPlugins, u.host, pathname + leaf);
}

const isFile = p => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

// The file standing where `p` needs a directory, if there is one. The nearest ancestor that exists settles
// it: everything above a directory is a directory.
function fileAbove(p, dotPlugins) {
  for (let dir = path.dirname(p); dir.length > dotPlugins.length; dir = path.dirname(dir)) {
    const found = statSync(dir, { throwIfNoEntry: false });
    if (found !== undefined) return found.isDirectory() ? undefined : dir;
  }
  return undefined;
}

// Write a fetched module, for the two cases where the mapping above is not the whole answer.
//
// A file in the way under a name with no module extension is one this layout no longer writes: what a
// cache from before it left behind (the half-fetched `ms@2.1.3` of the failure described above), and
// nothing looks for it there now. It is removed, or the upgrade would keep failing on its own residue.
// Anything else in the way is the collision the mapping cannot avoid, and is reported as that.
async function store(p, body, url, dotPlugins) {
  const write = async () => {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body, 'utf8');
  };
  try { return await write(); }
  catch (e) {
    const inTheWay = statSync(p, { throwIfNoEntry: false })?.isDirectory() ? p : fileAbove(p, dotPlugins);
    if (inTheWay === undefined) throw e;
    if (inTheWay !== p && !MODULE_EXT.test(inTheWay)) {
      await rm(inTheWay, { force: true });
      return write();
    }
    throw new Error(
      `Cannot cache ${url}: "${path.relative(dotPlugins, inTheWay)}" in the plugin cache has to be both a ` +
      `module and the directory of other modules, which a URL can be and a file tree cannot. Import one of ` +
      `them by a URL that does not share the name — a pinned version ("pkg.js@1.2.3") is cached beside its ` +
      `directory, not as it.`);
  }
}

// matbot source imports siblings with an explicit `.js` extension (verbatimModuleSyntax) while the file
// on disk is `.ts`, so one specifier has several plausible targets. Preference order, as the crawler had it.
function candidatesFor(url) {
  const candidates = [url];
  const bare = (url.split('?')[0]) ?? url;
  if (bare.endsWith('.js'))                              candidates.push(url.slice(0, -3) + '.ts');
  else if (bare.endsWith('.mjs'))                        candidates.push(url.slice(0, -4) + '.mts');
  else if (!/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(bare))   candidates.push(url + '.ts', url.replace(/\/?$/, '/') + 'index.ts');
  return candidates;
}

// Which URLs a specifier made from inside a fetched plugin could name, most preferred first; undefined when it
// is not ours to resolve (a bare one, or `node:`/`data:`).
function candidatesOf(specifier, parent) {
  const at = cacheLocation(parent);
  if (at === undefined) return undefined;

  let targetUrl;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    if (!/^https?:/i.test(specifier)) return undefined;      // node:, data: — not ours
    targetUrl = specifier;                                    // an absolute URL, possibly another host
  } else if (specifier.startsWith('/')) {
    targetUrl = `${schemeFor(at.hostDir)}//${at.host}${specifier}`;
  } else if (specifier.startsWith('.')) {
    targetUrl = new URL(specifier, `${schemeFor(at.hostDir)}//${at.host}/${at.rel}`).href;
  } else {
    return undefined;                                         // bare: host-provided, or a sibling plugin
  }
  return { dotPlugins: at.dotPlugins, candidates: candidatesFor(targetUrl) };
}

// Every candidate is checked on disk before any is fetched, for the same reason the mirrored tree is consulted
// before the network at all: the `.js` name is the preferred URL but the `.ts` name is what got written, so a
// per-candidate disk-then-network order would put a doomed request in front of the file we already have — and
// fail with no network at all. A warm boot therefore makes no requests, and an offline one works.
function onDisk({ dotPlugins, candidates }) {
  for (const candidate of candidates) {
    const p = urlToCachePath(candidate, dotPlugins);
    // A file, specifically: a directory of that name holds some other URL's children, and handing Node its
    // URL fails as a directory import, with nothing to say why.
    if (isFile(p)) return pathToFileURL(p).href;
  }
  return undefined;
}

/**
 * Resolve one specifier made from inside a fetched plugin, fetching it if we do not have it.
 *
 * Returns a file: URL, or undefined if this specifier is not ours to resolve (a bare one).
 */
export async function resolveFetched(specifier, parent) {
  const plan = candidatesOf(specifier, parent);
  if (plan === undefined) return undefined;
  const cached = onDisk(plan);
  if (cached !== undefined) return cached;

  let unreachable;
  for (const candidate of plan.candidates) {
    // The signal bounds the body as well as the headers: an origin that stalls mid-response is as stuck as
    // one that never answers, and either freezes the whole process, whose thread is waiting on this.
    let body;
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      body = await res.text();
    } catch (e) {
      unreachable ??= e?.name === 'TimeoutError' ? new Error(`no answer within ${FETCH_TIMEOUT_MS} ms`) : e;
      continue;
    }
    const p = urlToCachePath(candidate, plan.dotPlugins);
    await store(p, body, candidate, plan.dotPlugins);
    await recordOrigin(plan.dotPlugins, candidate);
    return pathToFileURL(p).href;
  }

  const reason = unreachable !== undefined
    ? `could not be reached (${unreachable.message})`
    : `was not found at ${plan.candidates.join(' or ')}`;
  throw Object.assign(new Error(`Cannot fetch "${specifier}" imported by ${parent}: it ${reason}.`),
                      { code: 'ERR_MODULE_NOT_FOUND' });
}

// The module hooks run in-thread and must answer synchronously, and a fetch can only be awaited. So when a
// fetched plugin imports a file we do not have yet, `resolveFetched` runs on a worker — this file, started as
// one — and the hook blocks until it answers: the round trip `module.register()` made for every import of the
// process, made only for these. A file already on disk never starts it.
//
// Blocking means the origin cannot be served by this same thread, as it could not under `register()` either
// since Node 24.12, whose hooks thread the main thread also waits on.
//
// Every wait is bounded, because a blocked thread runs nothing — no timer, no SIGINT handler — so an unbounded
// one is a process that can only be killed. A request is QUEUED until the worker takes it and DONE when it has
// answered. Never taken means the worker is not running (it failed to start, or died), which nothing else can
// report: its 'error' and 'exit' events are delivered on this thread, which is the one blocked. Taken and not
// answered by the time every candidate's fetch has had its full timeout means it is stuck. Either way the
// worker is discarded, so the next request starts a fresh one and no late answer can be read as its own.
const FETCHER = 'matbot-remote-fetcher';
const QUEUED = 0, WORKING = 1, DONE = 2;
const PICKUP_MS = 10_000;
let fetcher;

export function resolveFetchedSync(specifier, parent) {
  const plan = candidatesOf(specifier, parent);
  if (plan === undefined) return undefined;
  const cached = onDisk(plan);
  if (cached !== undefined) return cached;

  const current = fetcher ??= startFetcher();
  const state = new Int32Array(new SharedArrayBuffer(4));
  current.worker.postMessage({ specifier, parent, state });
  const stuck =
    Atomics.wait(state, 0, QUEUED, PICKUP_MS) === 'timed-out' ? `the fetch worker did not start within ${PICKUP_MS} ms`
    : Atomics.wait(state, 0, WORKING, plan.candidates.length * FETCH_TIMEOUT_MS + PICKUP_MS) === 'timed-out'
      ? 'the fetch worker did not answer in time'
    : undefined;
  if (stuck !== undefined) {
    if (fetcher === current) fetcher = undefined;
    void current.worker.terminate();
    throw Object.assign(new Error(`Cannot fetch "${specifier}" imported by ${parent}: ${stuck}.`),
                        { code: 'ERR_MODULE_NOT_FOUND' });
  }
  const answer = receiveMessageOnPort(current.answers).message;
  if ('error' in answer) throw Object.assign(new Error(answer.error), { code: answer.code });
  return answer.url;
}

function startFetcher() {
  const { port1, port2 } = new MessageChannel();
  // No `execArgv`: inheriting `--import ./register.js` would give the worker hooks it has no use for — its
  // own imports are plain JavaScript.
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { role: FETCHER, answers: port2 }, transferList: [port2], execArgv: [],
  });
  worker.unref();
  // A worker that fails reports it as an 'error' event, which with no listener would crash the process. The
  // request waiting on it has already said what went wrong; all that is left is not to reuse it.
  worker.on('error', () => {});
  worker.on('exit', () => { if (fetcher?.worker === worker) fetcher = undefined; });
  return { worker, answers: port1 };
}

if (!isMainThread && workerData?.role === FETCHER) {
  const { answers } = workerData;
  parentPort.on('message', async ({ specifier, parent, state }) => {
    Atomics.store(state, 0, WORKING);
    Atomics.notify(state, 0);
    try { answers.postMessage({ url: await resolveFetched(specifier, parent) }); }
    catch (e) { answers.postMessage({ error: e instanceof Error ? e.message : String(e), code: e?.code }); }
    Atomics.store(state, 0, DONE);
    Atomics.notify(state, 0);
  });
}
