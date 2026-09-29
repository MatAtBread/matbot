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

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, MessageChannel, receiveMessageOnPort, isMainThread, workerData, parentPort } from 'node:worker_threads';
import path from 'node:path';

const CACHE_DIR = '.plugins';

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

/** Where a URL's bytes live once fetched — the same mapping `remote-cache.ts` mirrors with. */
function urlToCachePath(url, dotPlugins) {
  const u = new URL(url);
  return path.join(dotPlugins, u.host, decodeURIComponent(u.pathname));
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
    if (existsSync(p)) return pathToFileURL(p).href;
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
    let res;
    try { res = await fetch(candidate); }
    catch (e) { unreachable ??= e; continue; }
    if (!res.ok) continue;
    const body = await res.text();
    const p = urlToCachePath(candidate, plan.dotPlugins);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body, 'utf8');
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
const FETCHER = 'matbot-remote-fetcher';
let fetcher;

export function resolveFetchedSync(specifier, parent) {
  const plan = candidatesOf(specifier, parent);
  if (plan === undefined) return undefined;
  const cached = onDisk(plan);
  if (cached !== undefined) return cached;

  fetcher ??= startFetcher();
  const done = new Int32Array(new SharedArrayBuffer(4));
  fetcher.worker.postMessage({ specifier, parent, done });
  Atomics.wait(done, 0, 0);
  const answer = receiveMessageOnPort(fetcher.answers).message;
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
  return { worker, answers: port1 };
}

if (!isMainThread && workerData?.role === FETCHER) {
  const { answers } = workerData;
  parentPort.on('message', async ({ specifier, parent, done }) => {
    try { answers.postMessage({ url: await resolveFetched(specifier, parent) }); }
    catch (e) { answers.postMessage({ error: e instanceof Error ? e.message : String(e), code: e?.code }); }
    Atomics.store(done, 0, 1);
    Atomics.notify(done, 0);
  });
}
