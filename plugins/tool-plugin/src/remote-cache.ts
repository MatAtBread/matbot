// Remote plugin fetch-and-cache for the Node host.
//
// matbot plugins are raw `.ts` modules whose *shared* dependencies are host singletons
// (`@matatbread/matbot-*`, already present in the host's node_modules) and whose *relative*
// imports are sibling files. They are not pnpm-installable packages: their package.json uses
// `workspace:`/`catalog:` protocols and points `exports` at uncompiled `./src/*.ts`. So a
// github/URL plugin is installed by mirroring its file tree onto disk under `.plugins/` and
// importing the cached entry through the normal Node strip-only loader — the disk equivalent of
// the web bundle's "singleton boundary" (bare imports resolve up to the host's node_modules;
// relative imports resolve to the fetched siblings on disk). No import rewriting is needed.
//
// The cache deliberately lives in `.plugins/` (next to matbot.yaml), NOT `.data/`: `.data/` is
// the LLM's read-write runtime state, whereas `.plugins/` is matbot-writes / LLM-reads-only
// (e.g. mounted read-only into docker-bash) so cached plugin code cannot be tampered with by the
// model. Do not move this under `.data/`.

import { writeFile, readFile, readdir, mkdir, access, stat, realpath, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';
import path from 'node:path';

// ── Specifier classification ────────────────────────────────────────────────────

// THREE ROUTES, and the whole taxonomy, because each hands resolution to whoever already owns it. The
// distinction that does the work is what KIND of thing a specifier is:
//
//   local — a path, or a bare name the disk already answers: a package under `plugins/` DECLARING that
//           name counts, since `@matatbread/matbot-edit-session` lives in `plugins/edit-session` and no
//           path rule would ever find it. Already an answer; the FILESYSTEM resolved it. Its declared
//           dependencies are installed on the way in (see ./provision.ts).
//   npm   — a bare name nothing local claims, plus an explicit `npm:` prefix, a tarball or a git URL.
//           A version suffix (`foo@^1.2`) is always this route, even where a local `foo` exists: a
//           range is a constraint to solve, and only a registry can answer it.
//           A QUESTION: `^1.2.3` means "something satisfying this", which needs constraint solving, a
//           registry, a lockfile and integrity checking. The PACKAGE MANAGER owns all of that.
//   http  — an `http(s)://` URL, or the `github:` shorthand for one. Also an answer: nothing to resolve
//           but a fetch. Versioning, immutability and integrity belong to whoever serves it — `@0.4.4`
//           in a CDN path, a tag or a SHA in a GitHub ref. It fetches ONE package's files and installs
//           no dependency graph, so a bare import must already be present (host copies, or a
//           previously-fetched plugin by canonical name).
//
// There used to be five, and two of them were the same route reached by punctuation: a `.tgz` was
// `pnpm-url` while a directory URL was `remote`, and `github:o/r#path:sub` switched mechanism entirely on
// the strength of a `#`. Which mechanism runs is now decided by what the specifier IS, and `npm:` is the
// one explicit override.
export type Classified =
  | { kind: 'local';        dir: string }   // a package.json was confirmed at/above the resolved dir
  | { kind: 'npm';          spec: string }  // what the package manager is asked for — `npm:` already stripped
  | { kind: 'http';         spec: string; url: string; advice?: string }  // `url` is `spec` normalised; `advice` = rewrite this
                                                        // specifier (it still works)
  | { kind: 'missing-path'; resolved: string }; // looked like a path but no package.json exists there

// A tarball or a git repo is a URL, and still not the http route: there is nothing importable at the far
// end until something unpacks or clones it, which is a package manager's job. So the shape routes to npm
// — and `npm:` says the same thing explicitly, for a URL whose shape does not give it away.
function isTarballOrGit(url: string): boolean {
  const noQuery = (url.split('?')[0]) ?? url;
  return noQuery.endsWith('.tgz') || noQuery.endsWith('.tar.gz') || noQuery.endsWith('.git') || url.startsWith('git+');
}

/**
 * If `resolved` exists on disk, return the nearest ancestor directory holding a package.json (the
 * package the path belongs to); otherwise undefined. Existence is checked FIRST so a non-existent
 * path is never mis-classified as local just because some ancestor (e.g. the project root) happens
 * to carry a package.json. A file resolves from its containing directory.
 */
async function resolveLocalDir(resolved: string): Promise<string | undefined> {
  let info;
  try { info = await stat(resolved); } catch { return undefined; }
  let cur = info.isDirectory() ? resolved : path.dirname(resolved);
  for (;;) {
    try { await access(path.join(cur, 'package.json')); return cur; } catch { /* keep walking up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * The directory of a local plugin package whose package.json declares `name`, or undefined.
 *
 * A bare name is a path on disk only by coincidence: in a source checkout
 * `@matatbread/matbot-edit-session` lives in `plugins/edit-session`, a directory whose path bears no
 * resemblance to the package it holds. So the disk is asked the question it can actually answer —
 * "does anything here CALL itself this?" — and only a name nothing local claims is a registry
 * question. Otherwise adding a plugin by its portable package name in a full checkout would fetch a
 * *published copy of code already on disk*: a second package, free to skew in version, shadowing the
 * source the user is working on.
 *
 * The root is exactly `discover_local`'s local half (`plugins`, two deep, as the flat-but-grouped
 * layout needs), so a name that tool reports is a name this resolves. `.plugins/` is deliberately not
 * consulted: a fetched plugin's identity is the URL it came from, which is what `discover_local`
 * offers as its specifier.
 */
async function localPluginDirByName(name: string, projectDir: string): Promise<string | undefined> {
  const scan = async (dir: string, depth: number): Promise<string | undefined> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return undefined; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const sub = path.join(dir, entry.name);
      try {
        const pkg = JSON.parse(await readFile(path.join(sub, 'package.json'), 'utf8')) as { name?: unknown };
        if (pkg.name === name) return sub;
      } catch { /* not a package, or unreadable — a grouping directory, so keep descending */ }
      if (depth < 2) {
        const found = await scan(sub, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return scan(path.join(projectDir, 'plugins'), 1);
}

const sameDir = async (a: string, b: string): Promise<boolean> => {
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return (await realpath(a)) === (await realpath(b)); } catch { return false; }
};

/**
 * The canonical package name to RECORD for a local plugin directory, or undefined when the path is the
 * only form that resolves.
 *
 * A name is the portable specifier — it resolves in a source checkout and in an installed deployment
 * alike, and it is the handle `remove`/`reload` address a plugin by — so a config entry should say the
 * name whenever the name works. (The `provider` tool and the setup wizard already write package names
 * for exactly this reason.) It is offered only when it resolves BACK to this very directory: a package
 * under `plugins/` is found by name, one anywhere else (a compiled plugin in `compiled-plugins/`, a
 * sibling checkout reached by `../`) is not, and recording a name that resolves elsewhere — or nowhere —
 * would point the config at something other than what was just approved.
 */
export async function canonicalLocalSpecifier(dir: string, projectDir: string): Promise<string | undefined> {
  let name: unknown;
  try {
    name = (JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch { return undefined; }
  if (typeof name !== 'string' || name === '') return undefined;
  const byName = await localPluginDirByName(name, projectDir);
  if (byName === undefined) return undefined;
  return (await sameDir(byName, dir)) ? name : undefined;
}

/**
 * Classify a specifier by shape and — for anything path-like or bare — by what is actually on disk.
 *
 * Order matters and is deliberate: an explicit `npm:` first (the one override), then URL shapes, then
 * the disk, and only what the disk does not have falls through to the registry. A scoped `@scope/name`
 * is checked on disk too, rather than being assumed to be a registry name: a bare specifier is a
 * *question* only when nothing local already answers it — as a path, or as a package that declares
 * that name.
 *
 * `advice` is a migration message for a specifier that still works but should be rewritten. It is
 * returned rather than printed so the caller can put it where its user will see it.
 */
export async function classifySpecifier(spec: string, projectDir: string): Promise<Classified> {
  // The explicit force. Anything the shape rules would send elsewhere — a bare name that happens to
  // exist on disk, a URL serving a tarball with no `.tgz` in its path — goes to the package manager.
  if (spec.startsWith('npm:')) return { kind: 'npm', spec: spec.slice('npm:'.length) };

  if (/^https?:\/\//.test(spec) || spec.startsWith('git+')) {
    if (isTarballOrGit(spec)) return { kind: 'npm', spec };
    return { kind: 'http', spec, url: spec };
  }
  if (spec.startsWith('github:')) {
    const { url, advice } = githubToHttps(spec);
    return { kind: 'http', spec, url, ...(advice !== undefined ? { advice } : {}) };
  }

  // Path-like shapes: resolve against the project dir and confirm a package.json exists.
  const explicitPath = spec.startsWith('file://') || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
  const resolved     = spec.startsWith('file://') ? fileURLToPath(spec) : path.resolve(projectDir, spec);

  if (explicitPath) {
    const dir = await resolveLocalDir(resolved);
    return dir !== undefined ? { kind: 'local', dir } : { kind: 'missing-path', resolved };
  }
  // Bare, scoped or not: local if it resolves to an existing package on disk — by path, or by being
  // the name a local plugin package declares — else a registry name.
  const dir = await resolveLocalDir(resolved);
  if (dir !== undefined) return { kind: 'local', dir };
  const byName = await localPluginDirByName(spec, projectDir);
  if (byName !== undefined) return { kind: 'local', dir: byName };
  return { kind: 'npm', spec };
}

// ── Remote manifest + entry resolution ──────────────────────────────────────────

export interface RemoteManifest {
  pkg:      Record<string, unknown>;
  pkgUrl:   string;             // the governing package.json URL (always resolved — its absence is an error)
  entryUrl: string;             // absolute URL of the module entry to import
  runtimes: readonly string[] | undefined; // package.json `matbotRuntime`, if declared
}

const CODE_EXT = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/**
 * Expand a `github:owner/repo[/sub][#ref]` shorthand into a raw.githubusercontent.com base URL — the one
 * place this translation happens, so classification and fetching cannot disagree about what a specifier
 * means.
 *
 * It also accepts pnpm's legacy git-subdirectory fragment (`#path:sub`, `#ref&path:sub`) and folds it
 * into the path, with advice to rewrite it. That fragment used to switch the specifier to a
 * package-manager install, and it never worked: npm ignores `#path:` and installs the ENTIRE monorepo
 * under the repo's name, reporting success; pnpm extracts the right package but leaves `workspace:^`
 * peers unmet. Fetching the subdirectory over https is the thing that does work.
 */
function githubToHttps(spec: string): { url: string; advice?: string } {
  const body     = spec.slice('github:'.length);
  const hash     = body.indexOf('#');
  const pathPart = hash === -1 ? body : body.slice(0, hash);
  const fragment = hash === -1 ? ''   : body.slice(hash + 1);

  let ref = 'HEAD';
  let fragmentSub = '';
  for (const part of fragment.split('&').filter(Boolean)) {
    if (part.startsWith('path:')) fragmentSub = part.slice('path:'.length).replace(/^\/+|\/+$/g, '');
    else ref = part;
  }

  const segs  = pathPart.split('/').filter(Boolean);
  const owner = segs[0] ?? '';
  const repo  = segs[1] ?? '';
  const sub   = [segs.slice(2).join('/'), fragmentSub].filter(Boolean).join('/');
  const base  = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/`;
  const url   = sub ? new URL(sub + '/', base).href : base;

  if (fragmentSub === '') return { url };
  const rewritten = `github:${owner}/${repo}/${sub}${ref === 'HEAD' ? '' : `#${ref}`}`;
  return { url, advice:
    `"${spec}" uses pnpm's \`#path:\` git-subdirectory fragment, which no package manager can actually ` +
    `install from an unpublished repo. It is now fetched over https like any other subdirectory — write it ` +
    `as "${rewritten}" instead.` };
}

function resolveExportsEntry(exports: unknown): string | undefined {
  if (typeof exports === 'string') return exports;
  if (exports === null || typeof exports !== 'object') return undefined;
  const obj = exports as Record<string, unknown>;
  const dot = '.' in obj ? obj['.'] : obj;
  if (typeof dot === 'string') return dot;
  if (dot === null || typeof dot !== 'object') return undefined;
  const conds = dot as Record<string, unknown>;
  for (const key of ['import', 'module', 'default', ...Object.keys(conds)]) {
    if (key in conds) {
      const v = conds[key];
      if (typeof v === 'string') return v;
    }
  }
  return undefined;
}

const manifestCache = new Map<string, RemoteManifest>();

async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url);
  return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
}

/**
 * Read `url`'s mirrored copy, or undefined if we do not have one. THE MIRRORED TREE IS THE CACHE:
 * a file already under `.plugins/<host>/<path…>` is read from disk and never re-fetched, which is
 * what makes a warm boot cost nothing and work with no network at all.
 *
 * That is a deliberate trade, not an optimisation: it means a boot never picks up changed upstream
 * source. It already didn't — `writeCached` refuses to overwrite a mirrored file, so re-fetching one
 * could only ever discard what it learned. `plugin reload --refresh` is the one path that wants
 * upstream, and it evicts the subtree first, so these reads miss and the network answers.
 */
async function readMirrored(url: string, dotPlugins: string): Promise<string | undefined> {
  try { return await readFile(urlToCachePath(url, dotPlugins), 'utf8'); }
  catch { return undefined; }
}

/**
 * Resolve a remote specifier to its package.json (if any) and entry URL — WITHOUT downloading the
 * module graph. The caller uses this to verify the plugin (matbotRuntime, a resolvable entry)
 * before consenting to download and execute any code. Memoised per specifier.
 *
 * `live` goes to the network even when the manifest is already mirrored. Materialisation does not:
 * the mirrored manifest is the one the import will resolve against, and reading it is what lets a
 * warm boot resolve an entry offline. The two callers that pass `live` are the ones whose whole point
 * is upstream — the pre-install gate (deciding whether to fetch this plugin at all) and eviction
 * (which exists so a moved entry, a renamed package or a changed `files` list is re-read).
 */
export async function fetchRemoteManifest(spec: string, dotPlugins: string, live = false): Promise<RemoteManifest> {
  const cached = manifestCache.get(spec);
  if (cached !== undefined) return cached;

  let url = spec.startsWith('github:') ? githubToHttps(spec).url : spec;

  // A direct entry URL (…/index.ts): import that entry, but the plugin is still a *package*, so a
  // sibling package.json bearing the mandatory "name" (plus optional description / matbotRuntime gate)
  // must sit next to it. pkgUrl is set to that manifest so materialize mirrors it to disk beside the
  // entry, where the resolver's walk-up finds it.
  if (CODE_EXT.test((url.split('?')[0]) ?? url)) {
    const { url: pkgUrl, pkg } = await findEntryManifest(url, dotPlugins, live);
    const manifest: RemoteManifest = { pkg, pkgUrl, entryUrl: url, runtimes: runtimesOf(pkg) };
    manifestCache.set(spec, manifest);
    return manifest;
  }

  // Otherwise resolve to a package.json: an explicit one, or by appending /package.json to a dir.
  if (!url.endsWith('/package.json')) {
    url = url.endsWith('/') ? url + 'package.json' : url + '/package.json';
  }
  const mirrored = live ? undefined : await readMirrored(url, dotPlugins);
  const r = mirrored !== undefined ? { ok: true, status: 200, text: mirrored } : await fetchText(url);
  if (!r.ok) {
    throw new Error(`could not fetch package.json (HTTP ${r.status}) at ${url}`);
  }
  const pkg = safeJson(r.text, url);
  if (typeof pkg['name'] !== 'string') {
    throw new Error(`package.json at ${url} declares no "name" (a remote plugin must be a named package)`);
  }
  const entryRel = resolveExportsEntry(pkg['exports']) ?? pkg['module'] ?? pkg['main'];
  if (typeof entryRel !== 'string') {
    throw new Error(`package.json at ${url} declares no "exports", "module", or "main" entry to load`);
  }
  const manifest: RemoteManifest = {
    pkg,
    pkgUrl:   url,
    entryUrl: new URL(entryRel, url).href,
    runtimes: runtimesOf(pkg),
  };
  manifestCache.set(spec, manifest);
  return manifest;
}

function safeJson(text: string, url: string): Record<string, unknown> {
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`package.json at ${url} is not valid JSON`); }
}

function runtimesOf(pkg: Record<string, unknown>): readonly string[] | undefined {
  const raw = pkg['matbotRuntime'];
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : undefined;
}

// matbot's remote-plugin contract: a plugin is a package, so a direct entry URL (…/index.ts) must
// sit beside its package.json — we check the sibling only, never fish up ancestors or down subdirs
// (a URL pointing into a tree could otherwise pick up an unrelated/monorepo manifest). Its absence,
// or a missing "name", is a hard error: point at the package dir or its package.json instead.
async function findEntryManifest(entryUrl: string, dotPlugins: string, live: boolean): Promise<{ url: string; pkg: Record<string, unknown> }> {
  const url = new URL('./package.json', entryUrl).href;
  const mirrored = live ? undefined : await readMirrored(url, dotPlugins);
  const r = mirrored !== undefined ? { ok: true, status: 200, text: mirrored } : await fetchText(url);
  if (r.ok) {
    const pkg = safeJson(r.text, url);
    if (typeof pkg['name'] === 'string') return { url, pkg };
  }
  throw new Error(`a remote plugin must be a named package: no sibling package.json with a "name" at ${url} (point at the package directory or its package.json instead)`);
}

// ── Materialisation (fetch the module graph onto disk) ───────────────────────────

function urlToCachePath(url: string, dotPlugins: string): string {
  const u = new URL(url);
  return path.join(dotPlugins, u.host, decodeURIComponent(u.pathname));
}

// matbot source imports siblings with explicit `.js` extensions (verbatimModuleSyntax); the raw
// file on disk is `.ts`. Mirror the web bundle: fetch the `.js`, fall back to `.ts`, and write the
// content at the `.ts` path so the ts-hooks `.js`→`.ts` resolve remap finds it at load time.
async function fetchModule(url: string, dotPlugins: string): Promise<{ finalUrl: string; content: string }> {
  const candidates: string[] = [url];
  const bare = (url.split('?')[0]) ?? url;
  if (bare.endsWith('.js'))        candidates.push(url.slice(0, -3) + '.ts');
  else if (bare.endsWith('.mjs'))  candidates.push(url.slice(0, -4) + '.mts');
  else if (!CODE_EXT.test(bare))   candidates.push(url + '.ts', url.replace(/\/?$/, '/') + 'index.ts');

  // Every candidate is tried on disk BEFORE any is tried on the network, because the two orders
  // disagree: the `.js` name is the preferred URL but the `.ts` name is what gets mirrored, so
  // per-candidate disk-then-network would put a doomed request for the `.js` in front of the file we
  // already have — one wasted round trip per module per boot, and a failure with no network at all.
  for (const candidate of candidates) {
    const mirrored = await readMirrored(candidate, dotPlugins);
    if (mirrored !== undefined) return { finalUrl: candidate, content: mirrored };
  }

  // An unreachable candidate is a miss, not the answer: the candidates are a preference order over
  // paths that mostly do not exist. Only when EVERY candidate is unreachable is the network itself the
  // finding — and then it is reported as such, rather than as a missing file.
  let unreachable: unknown;
  for (const candidate of candidates) {
    let r;
    try { r = await fetchText(candidate); }
    catch (e) { unreachable ??= e; continue; }
    if (r.ok) return { finalUrl: candidate, content: r.text };
  }
  if (unreachable !== undefined) {
    throw new Error(`could not fetch module ${url}: ${unreachable instanceof Error ? unreachable.message : String(unreachable)}`);
  }
  throw new Error(`could not fetch module ${url} (tried ${candidates.length} candidate path(s))`);
}

/**
 * Drop a remote plugin's cached state so the next materialize re-downloads it. Clears the in-memory
 * manifest memo (so a moved entry / changed `files` / renamed package is re-read), then removes the
 * cached package subtree under `.plugins/<host>/<path…>` and the plugin's `node_modules/<name>`
 * self-link. The manifest is re-fetched here to learn the subtree root and name; that fetch repopulates
 * the memo, so the subsequent `fetchRemoteManifest` in materialize hits it (one network round-trip).
 * Best-effort removal — an absent subtree/link is not an error.
 *
 * It must be a `live` fetch: reading the mirrored manifest would repopulate the memo with the copy
 * about to be deleted, and materialize would then crawl the OLD entry — which is exactly the case
 * (a moved entry, a renamed package) this function exists to catch.
 */
async function evictRemote(spec: string, dotPlugins: string): Promise<void> {
  manifestCache.delete(spec);
  const manifest = await fetchRemoteManifest(spec, dotPlugins, /* live */ true);
  const pkgRoot = path.dirname(urlToCachePath(manifest.pkgUrl, dotPlugins));
  await rm(pkgRoot, { recursive: true, force: true });

  const name = manifest.pkg['name'];
  if (typeof name === 'string' && !HOST_SINGLETONS.has(name)) {
    await rm(path.join(dotPlugins, 'node_modules', name), { force: true });
  }
}

/**
 * Put a remote plugin's ENTRY on disk and return where it landed, plus what its manifest declares that
 * nothing here satisfies.
 *
 * It used to fetch the whole module graph, predicted by three regexes over the source. Node's resolver
 * does that job properly — lazily, including dynamic imports, root-relative specifiers and absolute URLs —
 * so the graph is now fetched on demand by the module hook (apps/cli/remote-loader.js) as each import is
 * actually resolved. What is left here is what the hook cannot do for itself: the pre-fetch gate (a
 * package.json read before any of this plugin's code is on disk, let alone evaluated), the entry to hand
 * the loader, the scheme record the hook reconstructs URLs with, the self-link under the package's
 * canonical name so a sibling plugin can import it by name, and the declared non-code assets no import
 * will ever mention.
 *
 * Idempotent and offline once warm: every read tries the mirrored tree first, here and in the hook alike.
 * `forceRefresh` (from `plugin reload`) evicts this plugin's subtree, so those reads miss and upstream is
 * asked — the whole of the freshness story, deliberately, since `writeCached` will not overwrite.
 *
 * `resolveBase` is retained for the caller's benefit and no longer used to bridge anything: bare imports
 * from a fetched plugin resolve through Node, which finds a sibling plugin's self-link, or — one retry
 * later, in the hook — the host's own module graph.
 */
export async function materializeRemote(spec: string, dotPlugins: string, resolveBase: string, forceRefresh = false): Promise<MaterializedRemote> {
  void resolveBase;
  if (forceRefresh) await evictRemote(spec, dotPlugins);
  const manifest = await fetchRemoteManifest(spec, dotPlugins);

  const pkgPath = urlToCachePath(manifest.pkgUrl, dotPlugins);
  await writeCached(pkgPath, JSON.stringify(manifest.pkg, null, 2));

  await recordOrigin(dotPlugins, manifest.pkgUrl);

  // Two kinds of entry go in the farm under `.plugins/node_modules`, for one reason: a bare specifier from
  // inside the cache has to reach a real package on disk, which is exactly what a node_modules entry is for.
  //   - the plugin's OWN name, so a sibling plugin importing it by canonical name resolves to this fetched
  //     copy (`@matatbread/matbot-skills` from skills-node, `…-tool-store` from cognition);
  //   - the host's SINGLETONS, so `import … from '@matatbread/matbot-plugin-api'` reaches the copy the host
  //     loaded.
  // The host resolves all http specifiers before importing any, so by load time every fetched plugin's
  // self-link exists regardless of config order.
  const pkgRoot = path.dirname(pkgPath);
  await registerByName(manifest.pkg, pkgRoot, dotPlugins);
  await linkHostSingletons(dotPlugins);

  const { finalUrl, content } = await fetchModule(manifest.entryUrl, dotPlugins);
  const entry = urlToCachePath(finalUrl, dotPlugins);
  await writeCached(entry, content);

  await fetchDeclaredFiles(manifest.pkg, manifest.pkgUrl, dotPlugins);

  // A declared dependency is the one place a plugin states what it needs that this route does not bring —
  // and the only place a matbot-plugin dependency (`mcp` → `mcp-http`, `skills-node` → `skills`, …) is
  // named at all. An unsatisfied *import* is no longer guessed at from the source: the hook fails the
  // resolution it actually attempted, naming the specifier and the importer, which is both accurate and
  // impossible to false-positive on.
  const deps = manifest.pkg['dependencies'];
  const declared = (deps !== null && typeof deps === 'object' ? Object.keys(deps) : [])
    .filter(name => !HOST_SINGLETONS.has(name));

  return { entry, pkgRoot, unsatisfied: declared };
}

export interface MaterializedRemote {
  /** Local file path of the plugin's entry — what the host imports. */
  entry:   string;
  /** The cached package root: the base a runtime import of this plugin actually resolves from. */
  pkgRoot: string;
  /** Declared dependency names, to re-check with `remoteDependencyNotes` once every remote is on disk. */
  unsatisfied: readonly string[];
}

// A dependency's *name* is the only signal available without another fetch, and it is enough: the
// convention is a `matbot-` prefixed package (`@matatbread/matbot-skills`, `matbot-tool-whoami`), and
// being wrong only picks the less apt of two pieces of advice.
const LOOKS_LIKE_PLUGIN = /(?:^|\/)matbot-/;

/**
 * Turn a materialisation's declared dependencies into human notes, dropping anything that resolves by now.
 *
 * Deferred rather than decided during materialisation, because the symlink farm fills up as the batch
 * proceeds: a plugin depending on a sibling plugin appearing LATER in `matbot.yaml` has no link to it while
 * its own files are being fetched, and every remote is materialised before any is imported. Resolution is
 * re-tried from the cached package root — the base the import itself will use.
 */
export async function remoteDependencyNotes(m: MaterializedRemote): Promise<string[]> {
  const notes: string[] = [];
  const req = createRequire(path.join(m.pkgRoot, '_'));
  for (const name of m.unsatisfied) {
    if (hostPackageDir(req, name) !== undefined) continue;
    notes.push(LOOKS_LIKE_PLUGIN.test(name)
      ? `declares a dependency on "${name}", which is not present. That looks like a matbot plugin: add it to \`plugins:\` in matbot.yaml so it is fetched alongside this one.`
      : `declares a dependency on "${name}", which resolves nowhere the host can see. This route fetches one package's own files and bridges ` +
        `bare imports to packages already present — it installs no dependencies, so install "${name}" alongside matbot.`);
  }
  return notes;
}

// The scheme a host was reached over is NOT recoverable from `.plugins/<host>/…` — the tree keys on host so
// that one origin is one directory — and the module hook needs it to turn a relative import back into a
// URL. So each host records its own, and an absent record means https, which is what every cache written
// before this existed came from.
//
// The hook reads this file; it cannot import the name from here, because `plugins/` may not depend on
// `apps/`. Keep the two in sync — same arrangement as the reload stamp shared with ts-hooks.js.
const ORIGIN_FILE = '.origin';

async function recordOrigin(dotPlugins: string, url: string): Promise<void> {
  const u = new URL(url);
  const hostDir = path.join(dotPlugins, u.host);
  await mkdir(hostDir, { recursive: true });
  await writeFile(path.join(hostDir, ORIGIN_FILE), u.protocol, 'utf8');
}

// The host singletons must ALWAYS resolve to the host's own copy (the singleton boundary); a fetched
// plugin is never allowed to self-register under these names and shadow it. (A plugin is never named
// these in practice — defensive.)
const HOST_SINGLETONS = new Set(['@matatbread/matbot-plugin-api', '@matatbread/matbot-core']);

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Symlink `.plugins/node_modules/<pkg.name>` → the fetched plugin's cache dir. Idempotent; a name
 *  already linked (by an earlier self-registration or a host bridge) is left as-is — first writer wins. */
async function registerByName(pkg: Record<string, unknown>, pkgRoot: string, dotPlugins: string): Promise<void> {
  const name = pkg['name'];
  if (typeof name !== 'string' || HOST_SINGLETONS.has(name)) return;
  const linkPath = path.join(dotPlugins, 'node_modules', name);
  try { await access(linkPath); return; } catch { /* not linked yet */ }
  await mkdir(path.dirname(linkPath), { recursive: true });
  try { await symlink(pkgRoot, linkPath, LINK_TYPE); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
}

/**
 * Link the host's own singletons into `.plugins/node_modules`, so a fetched plugin's
 * `import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api'` reaches the copy the host loaded.
 *
 * "A bare specifier means host-provided" needs a path Node can walk, and there is not always one. An
 * npm-installed deployment usually has one by luck of layout — `.plugins/` sits inside a project whose flat
 * `node_modules/@matatbread/…` lies above it — but a pnpm workspace does not: its links live in each
 * package's own node_modules, so a checkout's root holds no `@matatbread` at all and the walk up from
 * `.plugins/<host>/…` finds nothing. Resolving it in the module hook instead is not equivalent, and was the
 * bug this replaces: the hook can only retry against its own file, and `apps/cli` depends on `core`, not on
 * `plugin-api`, so the one anchor available could not reach the very package the retry existed for. A link
 * is the disk's version of the browser bundle's import map, and every resolver honours it — the ESM
 * resolver, `createRequire`, tsc — rather than ESM alone.
 *
 * It points AT the host's own copy, so it is not a second one: `findDuplicateSingletons` resolves it to the
 * same realpath and stays silent, which is what that realpath test is for. A link that no longer leads
 * there (a moved checkout, a reinstalled store) is replaced rather than trusted, because `symlink()`
 * succeeds against a nonexistent target and so an existing link proves nothing.
 */
async function linkHostSingletons(dotPlugins: string): Promise<void> {
  for (const name of HOST_SINGLETONS) {
    const dir = hostOwnPackageDir(name);
    if (dir === undefined) continue;                       // this host does not have it: nothing to offer
    const linkPath = path.join(dotPlugins, 'node_modules', name);
    if (await sameDir(linkPath, dir)) continue;             // already leads to the host's copy
    await mkdir(path.dirname(linkPath), { recursive: true });
    await rm(linkPath, { recursive: true, force: true });
    await symlink(dir, linkPath, LINK_TYPE);
  }
}

// The import crawl only fetches code reachable by `import`. A plugin may also read non-imported
// runtime assets (e.g. frontend/web serves static/index.html, app.js via `new URL(..., import.meta.url)`).
// A raw host can't be directory-listed, so we mirror the *concrete* files the package declares in
// `files` (skipping directory entries like "src" — those are code, covered by the crawl — and globs).
// Best-effort: a missing asset warns and is skipped rather than aborting the install.
async function fetchDeclaredFiles(pkg: Record<string, unknown>, pkgUrl: string, dotPlugins: string): Promise<void> {
  const files = Array.isArray(pkg['files']) ? pkg['files'] : [];
  for (const raw of files) {
    if (typeof raw !== 'string') continue;
    const rel = raw.replace(/^\.?\//, '');
    const last = rel.split('/').pop() ?? '';
    if (rel.includes('*') || !last.includes('.')) continue; // glob or directory entry — not fetchable here
    const url = new URL(rel, pkgUrl).href;
    const cachePath = urlToCachePath(url, dotPlugins);
    try { await access(cachePath); continue; } catch { /* not mirrored yet */ }
    // Best-effort includes the network being gone. An asset that never cached (a 404, an interrupted
    // first boot) is retried on every boot, so without this an offline boot dies on the retry — for a
    // file the plugin may not even read.
    let bytes;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[matbot] declared file "${rel}" not fetched (HTTP ${res.status})`); continue; }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      console.warn(`[matbot] declared file "${rel}" not fetched: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, bytes);
  }
}

// Resolve a bare specifier the way the host would, from a chain of bases: the install root
// (`resolveBase`, where the user's own deps live) first, then this module's own location — which can
// always reach the core singletons (`@matatbread/matbot-core`/`-plugin-api`) that the host resolves
// transitively but that may not be directly installed at the root under pnpm.
function hostRequires(resolveBase: string): NodeRequire[] {
  return [createRequire(path.join(resolveBase, '_')), createRequire(import.meta.url)];
}

/**
 * The copy of `name` THIS MODULE resolves — which is the copy the running host uses, since tool-plugin is
 * loaded by the host and peer-depends on the singletons.
 *
 * Deliberately not `hostPackageDirFrom(name, configDir)`: that chain tries the config dir first, which
 * answers "what would a plugin there get" — the opposite question. Asking it about the host mistakes a
 * second copy installed beside matbot.yaml for the host's own, and `<configDir>/node_modules` is the most
 * likely place for one to be.
 */
export function hostOwnPackageDir(name: string): string | undefined {
  return hostPackageDir(createRequire(import.meta.url), name);
}

/** The directory `name` resolves to FROM `resolveBase`, falling back to this module's own resolution.
 *  Exported because provisioning links the same singletons this bridge links. */
export function hostPackageDirFrom(name: string, resolveBase: string): string | undefined {
  for (const req of hostRequires(resolveBase)) {
    const dir = hostPackageDir(req, name);
    if (dir !== undefined) return dir;
  }
  return undefined;
}

function hostPackageDir(req: NodeRequire, name: string): string | undefined {
  // Prefer the manifest (works regardless of an `exports` map); fall back to the entry, then walk up
  // to the directory whose package.json carries this name (matbot packages export only ".", so the
  // `${name}/package.json` subpath is usually blocked by exports).
  try { return path.dirname(req.resolve(`${name}/package.json`)); } catch { /* no exported package.json */ }
  let dir: string;
  try { dir = path.dirname(req.resolve(name)); } catch { return undefined; }
  for (;;) {
    try {
      const pkg = req(path.join(dir, 'package.json')) as { name?: string };
      if (pkg.name === name) return dir;
    } catch { /* no readable package.json here, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function writeCached(localPath: string, content: string): Promise<void> {
  try { await access(localPath); return; } catch { /* not cached yet */ }
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, content, 'utf8');
}
