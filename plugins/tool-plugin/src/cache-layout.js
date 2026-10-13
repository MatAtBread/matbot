// Where a fetched module lives under `.plugins/`, and how one is written there. The ONE statement of the
// layout, for the two things that use it: the module hook (apps/cli/remote-loader.js), which fetches a
// plugin's imports as Node resolves them, and remote-cache.ts, which puts its manifest and entry there first.
//
// Plain JavaScript with declarations beside it, because of who the first reader is: the hook IS the type
// stripper and its fetch worker runs with no hooks at all, so neither can load a `.ts`. This was two copies
// kept in step by a comment — and a rule that differs between them is a module written at one path and
// looked for at another, which is a refetch on every boot with nothing failing.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

// What Node loads by extension. A path ending in one of these is mirrored under its own name.
const MODULE_EXT = /\.(?:ts|mts|cts|js|mjs|cjs|json|wasm)$/;

// Appended to a path that has none. It ends `.mjs` because a module reached by URL is an ES module,
// whatever its path says, and the entry is imported by path with nothing to say so but the name. The
// underscore is there for the reason given at `urlToCachePath`, and is an underscore because a file: URL
// spells it as itself — `~` becomes `%7E` in every `import.meta.url` beneath it.
const BARE = '_.mjs';

/** Exactly where a URL says: `.plugins/<host>/<path…>`. Where an asset lives, and where every module did
 *  before a path with no extension was given one. */
export function verbatimCachePath(url, dotPlugins) {
  return path.join(dotPlugins, new URL(url).host, pathnameOf(url));
}

const pathnameOf = url => decodeURIComponent(new URL(url).pathname);

/**
 * Where a URL's module lives once fetched.
 *
 * A URL space lets one path be both a document and the prefix of others; a directory tree does not. And
 * that is the shape every npm CDN serves a bare package in: `https://esm.sh/ms@2.1.3` is a module whose own
 * imports live under `/ms@2.1.3/…`. Mirrored verbatim it took, as a FILE, the name its children need as a
 * directory, and the second fetch died in `mkdir` with ENOTDIR.
 *
 * So a path with no module extension is given one: `ms@2.1.3_.mjs`, beside `ms@2.1.3/`. Beside rather than
 * an index inside, because the file then stays in the directory its URL is in — a relative import from it
 * reconstructs the right URL with nothing to map back, and `import.meta.url` keeps the same neighbours. A
 * directory URL (`…/x/`) gets the same suffix and so lands inside the directory it names.
 *
 * The mapping must not send two URLs to one file: whichever was fetched first would be served for the
 * other, silently, and a stub at `…/index` re-exporting `./index.mjs` would import itself. A plain `.mjs`
 * did exactly that. Hence a suffix no path is likely to end in, and the one that does (`x_.mjs`, a real
 * URL) takes it a second time, which is what keeps it clear of the `x` beside it.
 *
 * A path that HAS a module extension otherwise stays where it is, because a plugin's own tree has to
 * remain a real package on disk. That leaves the one case no rule over the URL alone can settle: a name
 * that is a file by its extension and a directory by use (`https://esm.sh/chart.js` beside
 * `https://esm.sh/chart.js/auto`), which nothing distinguishes from an `index.js`. `storeModule` says so
 * rather than surfacing the errno. A pinned `chart.js@4.5.1` has no extension, so it is unaffected.
 */
export function urlToCachePath(url, dotPlugins) {
  const pathname = pathnameOf(url);
  const ownName = MODULE_EXT.test(pathname) && !pathname.endsWith(BARE);
  return verbatimCachePath(url, dotPlugins) + (ownName ? '' : BARE);
}

const isFile = p => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/**
 * The file holding a URL's module, if we have it.
 *
 * A file, specifically: a directory of that name holds some other URL's children, and handing Node its
 * path fails as a directory import, with nothing to say why.
 *
 * A module the earlier layout cached under its bare name is still that module, so it is found where it
 * was left. Without this an install that upgrades with a warm cache has to refetch every extensionless
 * import it already holds (jsdelivr's `/+esm`), and one that boots offline loses the plugin.
 */
export function cachedModulePath(url, dotPlugins) {
  const p = urlToCachePath(url, dotPlugins);
  if (isFile(p)) return p;
  if (MODULE_EXT.test(pathnameOf(url))) return undefined;
  const earlier = verbatimCachePath(url, dotPlugins);
  return isFile(earlier) ? earlier : undefined;
}

/**
 * Which URLs one import could name, most preferred first.
 *
 * matbot source imports siblings with an explicit `.js` extension (verbatimModuleSyntax) while the file
 * served is `.ts`, so one specifier has several plausible targets. A path with any OTHER module extension
 * names exactly itself: `data.json` is not a directory to look for an `index.ts` in.
 */
export function candidatesFor(url) {
  const candidates = [url];
  const bare = (url.split('?')[0]) ?? url;
  if (bare.endsWith('.js'))         candidates.push(url.slice(0, -3) + '.ts');
  else if (bare.endsWith('.mjs'))   candidates.push(url.slice(0, -4) + '.mts');
  else if (!MODULE_EXT.test(bare))  candidates.push(url + '.ts', url.replace(/\/?$/, '/') + 'index.ts');
  return candidates;
}

// The file standing where `p` needs a directory, if there is one. The nearest ancestor that exists settles
// it: everything above a directory is a directory.
function fileAbove(p, dotPlugins) {
  for (let dir = path.dirname(p); dir.length > dotPlugins.length; dir = path.dirname(dir)) {
    const found = statSync(dir, { throwIfNoEntry: false });
    if (found !== undefined) return found.isDirectory() ? undefined : dir;
  }
  return undefined;
}

// What a write reports when something of the wrong kind already has the name: a file where a directory is
// needed (ENOTDIR, or EEXIST when it is the last one), or a directory where the file goes. Any other
// failure — a full disk, a permission — is not about the layout and is nobody's to move a file over.
const NAME_TAKEN = new Set(['ENOTDIR', 'EEXIST', 'EISDIR']);

/**
 * Write a fetched module at `p`, for the two cases where the mapping above is not the whole answer.
 *
 * A file in the way under a name with no module extension is a module the earlier layout cached there (the
 * `ms@2.1.3` of the failure described above, or one that was working). It is MOVED to the name it has now,
 * not deleted: it may be the only copy of something a plugin imports, and a write that then fails for some
 * other reason must not have cost the cache a file. Only when its new name is already taken is it residue.
 *
 * Anything else in the way is the collision the mapping cannot avoid, and is reported as that.
 */
export async function storeModule(p, body, url, dotPlugins) {
  const write = async () => {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body, 'utf8');
  };
  try { return await write(); }
  catch (e) {
    if (!NAME_TAKEN.has(e?.code)) throw e;
    const inTheWay = statSync(p, { throwIfNoEntry: false })?.isDirectory() ? p : fileAbove(p, dotPlugins);
    if (inTheWay === undefined) throw e;
    if (inTheWay === p || MODULE_EXT.test(inTheWay)) {
      throw new Error(
        `Cannot cache ${url}: "${path.relative(dotPlugins, inTheWay)}" in the plugin cache has to be both a ` +
        `module and the directory of other modules, which a URL can be and a file tree cannot. Import one of ` +
        `them by a URL that does not share the name — a pinned version ("pkg.js@1.2.3") is cached beside its ` +
        `directory, not as it.`);
    }
    if (isFile(inTheWay + BARE)) await rm(inTheWay, { force: true });
    else await rename(inTheWay, inTheWay + BARE);
    return write();
  }
}
