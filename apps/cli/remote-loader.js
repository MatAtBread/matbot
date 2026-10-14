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
// the fetching belongs: when a fetched module asks for something we do not have, fetch it, store it under
// its identity, and hand that back.
//
// TWO IDENTITIES, by what the thing is.
//
// A PLUGIN'S OWN FILES are `file:`, mirrored under `.plugins/<host>/<path…>`. A plugin is a package, which
// was a file tree before it was served, so the mirror loses nothing — and being a real package on disk is
// what lets a Node-only plugin read its own files through `import.meta.url`, lets the dependencies `plugin
// add` installs beside it resolve, lets `discover_local` walk the tree, and lets docker-bash mount it
// read-only so the model can read what it fetched.
//
// A MODULE IMPORTED BY ABSOLUTE URL keeps that URL, as it does in the browser. A CDN's URL space is not a
// file tree: `https://esm.sh/ms@2.1.3` is a module AND the parent of `/ms@2.1.3/es2022/ms.mjs`, unpkg answers
// `lit@3?module` from `lit@3.3.3/index.js?module=`, and `?bundle` names a different module from the same path.
// Mirrored, each of those was a special case (issue #89 was the first). As its own URL, each is just how URLs
// work: Node resolves the module's imports against the URL that answered, and the cache is a store keyed on
// the URL, which never has to be a path.

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, MessageChannel, receiveMessageOnPort, isMainThread, workerData, parentPort } from 'node:worker_threads';
import path from 'node:path';
// The mirror's layout is stated once, in the package that also writes a plugin's entry into it. A plain .js
// file there, so that this one — which runs before anything strips types, and again on a worker with no
// hooks — can import it at all.
import { mirrorPath, mirroredFile, candidatesFor, schemeFor, recordOrigin } from '@matatbread/matbot-tool-plugin/cache-layout';

const CACHE_DIR = '.plugins';

// Per request, headers and body together. The worker reads the same value, inheriting this environment.
const FETCH_TIMEOUT_MS = Number(process.env.MATBOT_FETCH_TIMEOUT_MS) || 30_000;

// ── Modules imported by URL ─────────────────────────────────────────────────────
//
// `.plugins/.urls/`, a dot-directory so neither the cache scan nor `cacheLocation` reads it as a host. Each
// URL asked for has a record naming the URL that answered it (`<key>.json`), and each URL that answered has
// its body (`<key>.src`), where the key is a hash of the URL. Named by hash because a name derived from the
// URL is the mirror again: a path cannot be both a file and a directory, and `%2F` decodes into one.
//
// A record is written after its body, and each by rename, so a reader that finds a record finds the body —
// another process sharing the cache (a background job) can be fetching the same URL.
const URL_STORE = '.urls';

const keyOf = url => createHash('sha256').update(url).digest('hex').slice(0, 32);
const recordPath = (dotPlugins, url) => path.join(dotPlugins, URL_STORE, keyOf(url) + '.json');
const bodyPath = (dotPlugins, url) => path.join(dotPlugins, URL_STORE, keyOf(url) + '.src');

// Which cache each module that answered by URL lives in, so its own imports and its load find it. A module
// is always resolved before anything it imports, in the process that loads it, so this is never asked about
// a URL it has not been told.
const homeOf = new Map();

const isFile = p => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

function storedUrl(url, dotPlugins) {
  let answered;
  try { answered = JSON.parse(readFileSync(recordPath(dotPlugins, url), 'utf8')).answered; }
  catch { return fromMirror(url, dotPlugins); }
  return typeof answered === 'string' && isFile(bodyPath(dotPlugins, answered)) ? answered : undefined;
}

// A cache written before URL imports had their own store mirrored them, and an install that upgrades
// offline would otherwise lose every plugin that has one. So the copy is taken once, on a miss. Copied, not
// moved: the mirrored file stays whatever it was. Not for a URL with a query, which the mirror dropped — the
// file there may be another query's module — and not for a redirect, which the mirror could not record, so
// the copy answers for the URL it was saved under, as it always did.
function fromMirror(url, dotPlugins) {
  if (new URL(url).search !== '') return undefined;
  let file;
  try { file = mirroredFile(url, dotPlugins); } catch { return undefined; }
  if (file === undefined) return undefined;
  const body = bodyPath(dotPlugins, url);
  const record = recordPath(dotPlugins, url);
  mkdirSync(path.dirname(body), { recursive: true });
  const bodyTmp = `${body}.${randomUUID()}.tmp`, recordTmp = `${record}.${randomUUID()}.tmp`;
  copyFileSync(file, bodyTmp);
  renameSync(bodyTmp, body);
  writeFileSync(recordTmp, JSON.stringify({ asked: url, answered: url }), 'utf8');
  renameSync(recordTmp, record);
  return url;
}

async function writeAtomic(p, content) {
  const tmp = `${p}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, p);
}

async function storeFetched(dotPlugins, asked, answered, body) {
  await mkdir(path.join(dotPlugins, URL_STORE), { recursive: true });
  await writeAtomic(bodyPath(dotPlugins, answered), body);
  for (const url of new Set([answered, asked])) {
    await writeAtomic(recordPath(dotPlugins, url), JSON.stringify({ asked: url, answered }));
  }
}

// For the load hook, which has nothing but the URL.
export function loadStored(url) {
  const dotPlugins = homeOf.get(url);
  if (dotPlugins === undefined) return undefined;
  return readFileSync(bodyPath(dotPlugins, url), 'utf8');
}

// A module that answered by URL has no directory for Node to walk up from, so its bare imports resolve as
// though from the cache — reaching the host singletons and fetched plugins linked into
// `.plugins/node_modules`, then the project's own `node_modules`: what a bare import from a mirrored file reaches.
export function bareAnchor(parent) {
  const dotPlugins = typeof parent === 'string' ? homeOf.get(parent) : undefined;
  return dotPlugins === undefined ? undefined : pathToFileURL(path.join(dotPlugins, URL_STORE, 'importer.js')).href;
}

export function isFetched(url) {
  return (typeof url === 'string' && homeOf.has(url)) || cacheLocation(url) !== undefined;
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
  // A dot-directory is matbot's own bookkeeping (`.urls`, `.restore`), never a mirrored host.
  if (host.startsWith('.') || !/\.|:\d+$/.test(host)) return undefined;

  return {
    dotPlugins: parts.slice(0, at + 1).join(path.sep),
    hostDir:    parts.slice(0, at + 2).join(path.sep),
    host,
    rel:        parts.slice(at + 2).join('/'),
  };
}

// What a specifier made from inside a fetched module names; undefined when it is not ours to resolve (a bare
// one, or `node:`/`data:`). Either one URL, for the URL store, or the mirror's candidates, most preferred first.
function planOf(specifier, parent) {
  const absolute = /^https?:/i.test(specifier) || specifier.startsWith('//');
  if (!absolute && /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined;      // node:, data: — not ours
  if (!absolute && !specifier.startsWith('/') && !specifier.startsWith('.')) return undefined;  // bare

  // From a module that answered by URL, everything that is not bare is relative to that URL — as a browser
  // reads it, with no guessing at a `.ts` behind a `.js`.
  const home = typeof parent === 'string' ? homeOf.get(parent) : undefined;
  if (home !== undefined) return { dotPlugins: home, url: new URL(specifier, parent).href };

  const at = cacheLocation(parent);
  if (at === undefined) return undefined;
  const target = new URL(specifier, `${schemeFor(at.hostDir)}//${at.host}/${at.rel}`).href;
  return absolute ? { dotPlugins: at.dotPlugins, url: target }
                  : { dotPlugins: at.dotPlugins, candidates: candidatesFor(target) };
}

// Every candidate is checked on disk before any is fetched, for the same reason the mirrored tree is consulted
// before the network at all: the `.js` name is the preferred URL but the `.ts` name is what got written, so a
// per-candidate disk-then-network order would put a doomed request in front of the file we already have — and
// fail with no network at all. A warm boot therefore makes no requests, and an offline one works.
function onDisk(plan) {
  if (plan.url !== undefined) {
    const answered = storedUrl(plan.url, plan.dotPlugins);
    if (answered !== undefined) homeOf.set(answered, plan.dotPlugins);
    return answered;
  }
  for (const candidate of plan.candidates) {
    const p = mirroredFile(candidate, plan.dotPlugins);
    if (p !== undefined) return pathToFileURL(p).href;
  }
  return undefined;
}

async function fetchPlan(plan, specifier, parent) {
  const asked = plan.url !== undefined ? [plan.url] : plan.candidates;
  let unreachable;
  for (const candidate of asked) {
    // The signal bounds the body as well as the headers: an origin that stalls mid-response is as stuck as
    // one that never answers, and either freezes the whole process, whose thread is waiting on this.
    let res, body;
    try {
      res = await fetch(candidate, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) continue;
      body = await res.text();
    } catch (e) {
      unreachable ??= e?.name === 'TimeoutError' ? new Error(`no answer within ${FETCH_TIMEOUT_MS} ms`) : e;
      continue;
    }
    if (plan.url !== undefined) {
      // The URL that answered is the module: its imports are relative to it, and two URLs redirected to one
      // module load it once.
      const answered = res.url || candidate;
      await storeFetched(plan.dotPlugins, candidate, answered, body);
      homeOf.set(answered, plan.dotPlugins);
      return answered;
    }
    const p = mirrorPath(candidate, plan.dotPlugins);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body, 'utf8');
    await recordOrigin(plan.dotPlugins, candidate);
    return pathToFileURL(p).href;
  }

  const reason = unreachable !== undefined
    ? `could not be reached (${unreachable.message})`
    : `was not found at ${asked.join(' or ')}`;
  throw Object.assign(new Error(`Cannot fetch "${specifier}" imported by ${parent}: it ${reason}.`),
                      { code: 'ERR_MODULE_NOT_FOUND' });
}

// The module's URL — `file:` for a plugin's own file, the URL that answered for one imported by URL — or
// undefined if this specifier is not ours to resolve (a bare one).
export async function resolveFetched(specifier, parent) {
  const plan = planOf(specifier, parent);
  if (plan === undefined) return undefined;
  return onDisk(plan) ?? fetchPlan(plan, specifier, parent);
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
  const plan = planOf(specifier, parent);
  if (plan === undefined) return undefined;
  const cached = onDisk(plan);
  if (cached !== undefined) return cached;

  const current = fetcher ??= startFetcher();
  const state = new Int32Array(new SharedArrayBuffer(4));
  // The plan goes rather than the specifier, because only this thread knows which cache a module that
  // answered by URL lives in.
  current.worker.postMessage({ plan, specifier, parent, state });
  const stuck =
    Atomics.wait(state, 0, QUEUED, PICKUP_MS) === 'timed-out' ? `the fetch worker did not start within ${PICKUP_MS} ms`
    : Atomics.wait(state, 0, WORKING, (plan.candidates?.length ?? 1) * FETCH_TIMEOUT_MS + PICKUP_MS) === 'timed-out'
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
  if (plan.url !== undefined) homeOf.set(answer.url, plan.dotPlugins);
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
  parentPort.on('message', async ({ plan, specifier, parent, state }) => {
    Atomics.store(state, 0, WORKING);
    Atomics.notify(state, 0);
    try { answers.postMessage({ url: await fetchPlan(plan, specifier, parent) }); }
    catch (e) { answers.postMessage({ error: e instanceof Error ? e.message : String(e), code: e?.code }); }
    Atomics.store(state, 0, DONE);
    Atomics.notify(state, 0);
  });
}
