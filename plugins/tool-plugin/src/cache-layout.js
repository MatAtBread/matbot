// Where a fetched plugin's files live under `.plugins/`, for the two things that put them there: the module
// hook (apps/cli/remote-loader.js), which fetches a plugin's imports as Node resolves them, and
// remote-cache.ts, which writes its manifest, entry and declared files first. A rule that differs between
// the two is a file written at one path and looked for at another — a refetch on every boot with nothing
// failing — so it is stated once, here.
//
// Plain JavaScript with declarations beside it, because of who the first reader is: the hook IS the type
// stripper and its fetch worker runs with no hooks at all, so neither can load a `.ts`.
//
// This is the MIRROR, and it holds plugin packages only. A package was a file tree before it was ever
// served, so a URL inside one maps onto a path and back with nothing lost, and a Node-only plugin can read
// its own files through `import.meta.url`. A module a plugin imports by absolute URL is not placed here: a
// CDN's URL space is not a file tree — one path is a module and the parent of others, a response redirects,
// the query is part of the name — so it keeps its URL as its identity (remote-loader.js), as it does in the
// browser.

import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MODULE_EXT = /\.(?:ts|mts|cts|js|mjs|cjs|json|wasm)$/;

// Two spellings survive URL parsing that would put a path outside `.plugins/<host>/`: a host that is a dot
// segment (`http://../x` parses, with host `..`), and an encoded separator, which decodes into a segment the
// URL never had. Dot segments in the path, encoded or not, are already gone by the time this sees it. A host
// starting with a dot would also land in matbot's own bookkeeping (`.restore`), so both are refused.
export function mirrorPath(url, dotPlugins) {
  const u = new URL(url);
  if (u.host.startsWith('.') || /%2f|%5c/i.test(u.pathname)) {
    throw new Error(`Cannot cache ${url}: its host or path would name a file outside the plugin cache.`);
  }
  return path.join(dotPlugins, u.host, decodeURIComponent(u.pathname));
}

// A file, specifically: a directory of that name holds the files beneath it, and handing Node its path fails
// as a directory import with nothing to say why.
export function mirroredFile(url, dotPlugins) {
  const p = mirrorPath(url, dotPlugins);
  return statSync(p, { throwIfNoEntry: false })?.isFile() ? p : undefined;
}

// matbot source imports siblings with an explicit `.js` extension (verbatimModuleSyntax) while the file
// served is `.ts`, so one specifier has several plausible targets. A path with any OTHER module extension
// names exactly itself: `data.json` is not a directory to look for an `index.ts` in.
export function candidatesFor(url) {
  const candidates = [url];
  const bare = (url.split('?')[0]) ?? url;
  if (bare.endsWith('.js'))         candidates.push(url.slice(0, -3) + '.ts');
  else if (bare.endsWith('.mjs'))   candidates.push(url.slice(0, -4) + '.mts');
  else if (!MODULE_EXT.test(bare))  candidates.push(url + '.ts', url.replace(/\/?$/, '/') + 'index.ts');
  return candidates;
}

// The scheme is not recoverable from `.plugins/<host>/…` — the tree keys on host so that one origin is one
// directory — and the hook needs it to turn a relative import back into a URL. So each host records its
// own. Absent means https, which is what every cache written before the record existed came from.
const ORIGIN_FILE = '.origin';

const schemeByHostDir = new Map();

export function schemeFor(hostDir) {
  const cached = schemeByHostDir.get(hostDir);
  if (cached !== undefined) return cached;
  let scheme = 'https:';
  try { scheme = readFileSync(path.join(hostDir, ORIGIN_FILE), 'utf8').trim() || 'https:'; }
  catch { /* pre-existing cache, or a host we have not recorded — https */ }
  schemeByHostDir.set(hostDir, scheme);
  return scheme;
}

export async function recordOrigin(dotPlugins, url) {
  const u = new URL(url);
  const hostDir = path.join(dotPlugins, u.host);
  await mkdir(hostDir, { recursive: true });
  await writeFile(path.join(hostDir, ORIGIN_FILE), u.protocol, 'utf8');
  schemeByHostDir.set(hostDir, u.protocol);
}
