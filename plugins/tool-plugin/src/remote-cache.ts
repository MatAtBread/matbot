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

import { writeFile, mkdir, access, stat, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';
import path from 'node:path';

// ── Specifier classification ────────────────────────────────────────────────────

export type Classified =
  | { kind: 'local';        dir: string }   // a package.json was confirmed at/above the resolved dir
  | { kind: 'npm';          spec: string }  // bare registry name → pnpm add / node_modules resolution
  | { kind: 'remote';       spec: string }  // http(s)/github raw source → materialize into .plugins/
  | { kind: 'pnpm-url';     spec: string }  // .tgz tarball / git repo → pnpm add
  | { kind: 'missing-path'; resolved: string }; // looked like a path but no package.json exists there

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
 * Classify a specifier by shape and — for path-like specifiers — by what is actually on disk.
 * Unlike a pure string test, a bare `plugins/foo` is treated as a local path *iff* it
 * exists (with a package.json); otherwise it falls through to npm. An explicit path shape (`./`,
 * `../`, `file://`, or a leading `/`) that has no package.json is reported as `missing-path` rather
 * than silently mis-routed to a registry install.
 */
export async function classifySpecifier(spec: string, projectDir: string): Promise<Classified> {
  if (/^https?:\/\//.test(spec) || spec.startsWith('git+')) {
    return isTarballOrGit(spec) ? { kind: 'pnpm-url', spec } : { kind: 'remote', spec };
  }
  if (spec.startsWith('github:')) {
    // `#path:` is pnpm's git-subdirectory syntax — a real package in a subfolder, so hand it to pnpm.
    return spec.includes('#path:') ? { kind: 'pnpm-url', spec } : { kind: 'remote', spec };
  }

  // Path-like shapes: resolve against the project dir and confirm a package.json exists.
  const explicitPath = spec.startsWith('file://') || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
  const looksScoped  = spec.startsWith('@'); // @scope/name is always a registry name, never a path
  const resolved     = spec.startsWith('file://') ? fileURLToPath(spec) : path.resolve(projectDir, spec);

  if (explicitPath) {
    const dir = await resolveLocalDir(resolved);
    return dir !== undefined ? { kind: 'local', dir } : { kind: 'missing-path', resolved };
  }
  if (!looksScoped) {
    // Ambiguous bare string: local if it resolves to an existing package on disk, else an npm name.
    const dir = await resolveLocalDir(resolved);
    if (dir !== undefined) return { kind: 'local', dir };
  }
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

/** Expand a `github:owner/repo[/sub][#ref]` shorthand into a raw.githubusercontent.com base URL. */
function expandGithub(spec: string): string {
  const body = spec.slice('github:'.length);
  const [pathPart, ref = 'HEAD'] = body.split('#');
  const segs = (pathPart ?? '').split('/').filter(Boolean);
  const owner = segs[0] ?? '';
  const repo  = segs[1] ?? '';
  const sub   = segs.slice(2).join('/');
  const base  = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/`;
  return sub ? new URL(sub + '/', base).href : base;
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
 * Resolve a remote specifier to its package.json (if any) and entry URL — WITHOUT downloading the
 * module graph. The caller uses this to verify the plugin (matbotRuntime, a resolvable entry)
 * before consenting to download and execute any code. Memoised per specifier.
 */
export async function fetchRemoteManifest(spec: string): Promise<RemoteManifest> {
  const cached = manifestCache.get(spec);
  if (cached !== undefined) return cached;

  let url = spec.startsWith('github:') ? expandGithub(spec) : spec;

  // A direct entry URL (…/index.ts): import that entry, but the plugin is still a *package*, so a
  // sibling package.json bearing the mandatory "name" (plus optional description / matbotRuntime gate)
  // must sit next to it. pkgUrl is set to that manifest so materialize mirrors it to disk beside the
  // entry, where the resolver's walk-up finds it.
  if (CODE_EXT.test((url.split('?')[0]) ?? url)) {
    const { url: pkgUrl, pkg } = await findEntryManifest(url);
    const manifest: RemoteManifest = { pkg, pkgUrl, entryUrl: url, runtimes: runtimesOf(pkg) };
    manifestCache.set(spec, manifest);
    return manifest;
  }

  // Otherwise resolve to a package.json: an explicit one, or by appending /package.json to a dir.
  if (!url.endsWith('/package.json')) {
    url = url.endsWith('/') ? url + 'package.json' : url + '/package.json';
  }
  const r = await fetchText(url);
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
async function findEntryManifest(entryUrl: string): Promise<{ url: string; pkg: Record<string, unknown> }> {
  const url = new URL('./package.json', entryUrl).href;
  const r = await fetchText(url);
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
async function fetchModule(url: string): Promise<{ finalUrl: string; content: string }> {
  const candidates: string[] = [url];
  const bare = (url.split('?')[0]) ?? url;
  if (bare.endsWith('.js'))        candidates.push(url.slice(0, -3) + '.ts');
  else if (bare.endsWith('.mjs'))  candidates.push(url.slice(0, -4) + '.mts');
  else if (!CODE_EXT.test(bare))   candidates.push(url + '.ts', url.replace(/\/?$/, '/') + 'index.ts');

  for (const candidate of candidates) {
    const r = await fetchText(candidate);
    if (r.ok) return { finalUrl: candidate, content: r.text };
  }
  throw new Error(`could not fetch module ${url} (tried ${candidates.length} candidate path(s))`);
}

const IMP_FROM    = /\bfrom\s*['"]([^'"]+)['"]/g;
const IMP_SIDE    = /\bimport\s+['"]([^'"]+)['"]/g;
const IMP_DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Partition a module's import specifiers into the relative ones (siblings to fetch into the cache)
// and the bare ones (host packages to bridge via the symlink farm). node: builtins and absolute
// URLs are neither. A regex lexer over raw .ts is intentional: these are first-party controlled
// modules, and the only failure mode — over-collecting a string that looks like an import — is
// harmless (we fetch a real sibling file, or try to link a package that doesn't resolve and skip it).
function scanImports(code: string): { relative: string[]; bare: string[] } {
  const relative = new Set<string>();
  const bare     = new Set<string>();
  for (const re of [IMP_FROM, IMP_SIDE, IMP_DYNAMIC]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const spec = m[1];
      if (spec === undefined) continue;
      if (spec.startsWith('.')) relative.add(spec);
      else if (!spec.startsWith('node:') && !/^[a-z]+:\/\//i.test(spec)) bare.add(spec);
    }
  }
  return { relative: [...relative], bare: [...bare] };
}

/**
 * Download a remote plugin's module graph into `.plugins/<host>/<path…>`, preserving structure, and
 * return the local file path of its entry. Idempotent and offline-friendly: a module already present
 * in the cache is not re-fetched, so a restart loads from disk. (To force a refresh, delete the
 * plugin's subtree under `.plugins/`.)
 *
 * `resolveBase` is the directory whose module graph defines the host singletons — every bare import
 * the plugin makes (`@matatbread/matbot-plugin-api`, …) is resolved from here and symlinked into
 * `.plugins/node_modules/`, so the cached files resolve those packages to the SAME physical module
 * the host loaded (identity-sensitive checks like `instanceof MissingSecretError` depend on this).
 */
export async function materializeRemote(spec: string, dotPlugins: string, resolveBase: string): Promise<string> {
  const manifest = await fetchRemoteManifest(spec);

  await writeCached(urlToCachePath(manifest.pkgUrl, dotPlugins), JSON.stringify(manifest.pkg, null, 2));

  const { entryLocal, bare } = await crawl(manifest.entryUrl, dotPlugins);
  await linkHostPackages(bare, dotPlugins, resolveBase);
  await fetchDeclaredFiles(manifest.pkg, manifest.pkgUrl, dotPlugins);
  return entryLocal;
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
    try { await access(cachePath); continue; } catch { /* not cached yet */ }
    const res = await fetch(url);
    if (!res.ok) { console.warn(`[matbot] declared file "${rel}" not fetched (HTTP ${res.status})`); continue; }
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, Buffer.from(await res.arrayBuffer()));
  }
}

async function crawl(entryUrl: string, dotPlugins: string): Promise<{ entryLocal: string; bare: Set<string> }> {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entryUrl];
  let entryLocal: string | undefined;

  while (queue.length > 0) {
    const requested = queue.shift()!;
    const { finalUrl, content } = await fetchModule(requested);
    if (seen.has(finalUrl)) continue;
    seen.add(finalUrl);

    const localPath = urlToCachePath(finalUrl, dotPlugins);
    await writeCached(localPath, content);
    if (requested === entryUrl) entryLocal = localPath;

    const imports = scanImports(content);
    for (const rel of imports.relative) queue.push(new URL(rel, finalUrl).href);
    for (const b of imports.bare) bare.add(b);
  }

  if (entryLocal === undefined) throw new Error(`internal error: entry ${entryUrl} was not materialised`);
  return { entryLocal, bare };
}

/** The installable package name of a bare specifier (drops any subpath): `@scope/name` or `name`. */
function packageNameOf(spec: string): string {
  const segs = spec.split('/');
  return spec.startsWith('@') ? segs.slice(0, 2).join('/') : (segs[0] ?? spec);
}

// Bridge the cached plugin's bare imports to the host's copies via a symlink farm at
// `.plugins/node_modules/`. Node realpath-resolves symlinks, so a link to the host's package dir
// resolves to the exact module the host loaded — the disk equivalent of the web bundle's import map.
// A specifier that doesn't resolve from the host is skipped (it's a genuine missing dependency; the
// import then fails with a clear ERR_MODULE_NOT_FOUND rather than being silently masked).
async function linkHostPackages(bare: Set<string>, dotPlugins: string, resolveBase: string): Promise<void> {
  // Resolve bare specifiers the way the host would, from a chain of bases: the install root
  // (`resolveBase`, where the user's own deps live) first, then this module's own location — which
  // can always reach the core singletons (`@matatbread/matbot-core`/`-plugin-api`) that the host
  // resolves transitively but that may not be directly installed at the root under pnpm.
  const requires = [createRequire(path.join(resolveBase, '_')), createRequire(import.meta.url)];
  const nm  = path.join(dotPlugins, 'node_modules');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  for (const spec of bare) {
    const name     = packageNameOf(spec);
    const linkPath = path.join(nm, name);
    try { await access(linkPath); continue; } catch { /* not linked yet */ }

    let pkgDir: string | undefined;
    for (const req of requires) {
      pkgDir = hostPackageDir(req, name);
      if (pkgDir !== undefined) break;
    }
    if (pkgDir === undefined) continue;

    await mkdir(path.dirname(linkPath), { recursive: true });
    try { await symlink(pkgDir, linkPath, linkType); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
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
