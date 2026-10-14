import type { Tool, ToolExecutor, ToolEvent, ToolResultOf, ToolContext, MatbotPlugin, Runtime, PluginSource,
              PluginToolContract, DiscoveredPlugin } from '@matatbread/matbot-plugin-api';
import { isIncompatibleRuntimeError, isNotAPluginError, refusalMessage } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins, getRegisteredTools, getRegisteredFrontendPlugins,
         getRegisteredServiceKeys, getHookPlugins, getSystemContextPlugins,
         getSpecifierForPlugin, getPluginNameForSpecifier, getFailedPlugins, clearFailedPlugin } from '@matatbread/matbot-core';
import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath }       from 'node:url';
import { createRequire }                     from 'node:module';
import path                                  from 'node:path';
import { classifySpecifier, fetchRemoteManifest, canonicalLocalSpecifier, materializeRemote,
         restoreRemote, discardRestore, releaseRemote } from '../remote-cache.js';
import { planProvision, applyProvision, discardProvision, removeProvisioned, localProvision, registryManifest,
         runCommand, type ProvisionPlan } from '../provision.js';
import { readInstallRecord, writeInstallRecord, dropInstallRecord, declaredDependencies, isPackageName,
         type InstallRecord } from '../install-record.js';
import { findDuplicateSingletons } from '../singletons.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readPluginsList(configPath: string): Promise<string[]> {
  const text  = await readFile(configPath, 'utf8');
  const match = text.match(/^plugins:\s*\n((?:[ \t]+-[^\n]*\n)*)/m);
  if (!match) return [];
  return (match[1] ?? '').split('\n')
    .map(l => l.replace(/^[ \t]+-\s*/, '').trim())
    .filter(Boolean);
}

async function addPlugin(configPath: string, specifier: string): Promise<void> {
  const text  = await readFile(configPath, 'utf8');
  // Match the specifier as a whole list item, not a substring: `- ./plugins/tool-router` must NOT count
  // as already-present just because `- ./plugins/tool-routerx` shares its prefix. The old
  // `text.includes('- ' + specifier)` false-positived on any prefix, silently skipping the write — the
  // plugin then loaded (active in-memory) but never persisted to the config, so it vanished on restart.
  if (new RegExp(`^[ \\t]+-[ \\t]+${escapeRegex(specifier)}[ \\t]*$`, 'm').test(text)) return;

  let updated: string;
  const blockMatch = text.match(/^(plugins:\s*\n(?:[ \t]+-[^\n]*\n)*)/m);
  if (blockMatch) {
    const at = blockMatch.index! + blockMatch[0].length;
    updated  = text.slice(0, at) + `  - ${specifier}\n` + text.slice(at);
  } else {
    const pi = text.indexOf('\nproviders:');
    updated  = pi !== -1
      ? text.slice(0, pi) + `\nplugins:\n  - ${specifier}\n` + text.slice(pi)
      : `plugins:\n  - ${specifier}\n\n` + text;
  }
  await writeFile(configPath, updated, 'utf8');
}

async function removePlugin(configPath: string, specifier: string): Promise<boolean> {
  const text    = await readFile(configPath, 'utf8');
  const updated = text.replace(new RegExp(`^[ \\t]+-[ \\t]+${escapeRegex(specifier)}\\n`, 'm'), '');
  if (updated === text) return false;
  await writeFile(configPath, updated, 'utf8');
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve package.json `exports["."]` to a node-importable entry. Discovery imports under node, so we
// honour the node ESM conditions ({node, import, default}) and skip browser/require — frontend-web's
// `{ browser, import, default }` form would otherwise resolve to `undefined` and be silently dropped.
function resolveCondition(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (target === null || typeof target !== 'object') return undefined;
  for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
    if (key === 'node' || key === 'import' || key === 'default') {
      const resolved = resolveCondition(value);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

function resolveExportsMain(exports: unknown): string | undefined {
  if (typeof exports === 'string') return exports;
  if (exports !== null && typeof exports === 'object') {
    return resolveCondition((exports as Record<string, unknown>)['.']);
  }
  return undefined;
}

// What `discoverLocalPlugins` builds, before the caller stamps `configuredVia` from the config it read.
type DiscoveryEntry = Omit<DiscoveredPlugin, 'configuredVia'>;

// The contract is shared with the browser implementation of this same tool name (a `ToolContracts` key
// is registered by declaration merging, so two implementations cannot each describe themselves — see
// plugin-api/src/types/builtin-tools.ts).
declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    plugin: PluginToolContract;
  }
}

// Inspect one candidate directory: it is a plugin only if its entry module actually exports a
// `plugin` object — the same contract the loader enforces. The package.json plugin-api dependency is
// only a cheap pre-filter (a library may import the API for its *types*, e.g. `Store<T>`, yet export
// no plugin); making the import load-bearing is what stops such a library from being offered here and
// then failing at install. Returns the discovery entry (with the caller-supplied specifier + source),
// or null.
async function inspectPluginDir(sub: string, specifier: string, source: { type: PluginSource; uri: string }): Promise<DiscoveryEntry | null> {
  let pkg: { name?: string; version?: string; description?: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; exports?: unknown; matbotRuntime?: unknown };
  try {
    pkg = JSON.parse(await readFile(path.join(sub, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return null;
  }
  // plugin-api is a peerDependency on a published plugin (the host provides the singleton); a
  // monorepo/source plugin may list it under dependencies. Either declaration passes the pre-filter.
  if (pkg.dependencies?.['@matatbread/matbot-plugin-api'] === undefined
      && pkg.peerDependencies?.['@matatbread/matbot-plugin-api'] === undefined) return null;

  // The entry is resolved from exports["."] (so we import the .ts file directly, not the directory).
  // No resolvable entry, an import that rejects, or a module with no `plugin` export → not a plugin.
  const exportsMain = resolveExportsMain(pkg.exports);
  if (!exportsMain) return null;
  let p: MatbotPlugin | undefined;
  try {
    const mod = await import(pathToFileURL(path.join(sub, exportsMain)).href) as Record<string, unknown>;
    p = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
  } catch {
    return null;
  }
  if (p === undefined) return null;

  // Prefer manifest.description (runtime source of truth) over package.json description.
  const description = p.manifest?.description ?? pkg.description ?? '';
  const runtimes    = normalizeRuntimes(pkg.matbotRuntime);
  return {
    specifier,
    name:        pkg.name ?? path.basename(sub),
    description,
    source,
    ...(pkg.version !== undefined ? { version: pkg.version } : {}),
    ...(runtimes !== undefined ? { matbotRuntime: runtimes } : {}),
  };
}

/**
 * Is this discovered plugin already named by a config section?
 *
 * A specifier is not an identity, so this cannot be a string lookup — which is what it was, against the
 * path form discovery happens to build (`./plugins/foo`). The moment `plugin add` began recording the
 * canonical package name, a plugin that is configured AND loaded started reporting `configuredVia: null`,
 * because `@scope/foo` is not the string `./plugins/foo`. The same blindness covered an absolute path or a
 * `file:` URL naming the very same directory.
 *
 * So compare what an entry REFERS to: the package's name, the specifier as discovery wrote it, or — for
 * anything path-shaped — the directory it resolves to. A bare name that is not this package's name, and a
 * URL, are left to the name/specifier comparison: neither addresses a local directory.
 */
function configuredIn(entries: ReadonlySet<string>, p: DiscoveryEntry, projectDir: string): boolean {
  if (entries.has(p.specifier) || entries.has(p.name)) return true;

  const dir = p.source?.uri.startsWith('file:') === true ? fileURLToPath(p.source.uri) : undefined;
  if (dir === undefined) return false;
  const target = path.resolve(dir);

  for (const entry of entries) {
    let entryDir: string | undefined;
    if (entry.startsWith('file:')) {
      try { entryDir = fileURLToPath(entry); } catch { continue; }
    } else if (entry.startsWith('./') || entry.startsWith('../') || path.isAbsolute(entry)) {
      entryDir = path.resolve(projectDir, entry);
    }
    if (entryDir !== undefined && path.resolve(entryDir) === target) return true;
  }
  return false;
}

// TODO: This is a convenience shim for end users in monorepo setups and is
// intentionally narrow. It should eventually be replaced with a proper
// discovery interface — registry lookup, repo scanning, or a plugin marketplace.
//
// Two roots are scanned: the monorepo's `plugins` (source: local) and, if present, the
// `.plugins/` remote-plugin cache (source: github for raw.githubusercontent.com, else cdn) — so a
// previously-fetched remote plugin is rediscoverable and re-installable by its original URL.
async function discoverLocalPlugins(projectDir: string): Promise<DiscoveryEntry[]> {
  const results: DiscoveryEntry[] = [];

  const scanLocal = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      const specifier = `./${path.relative(projectDir, sub).replace(/\\/g, '/')}`;
      const found = await inspectPluginDir(sub, specifier, { type: 'local', uri: pathToFileURL(sub).href });
      if (found) results.push(found);
      if (depth < 2) await scanLocal(sub, depth + 1);
    }
  };

  const pluginsDir = path.join(projectDir, 'plugins');
  try { await access(pluginsDir); await scanLocal(pluginsDir, 1); } catch { /* no monorepo plugins dir */ }

  await scanCacheDir(path.join(projectDir, '.plugins'), results);
  return results;
}

// Walk the `.plugins/<host>/<path…>` cache, reconstructing each cached package's original URL
// specifier. Descent stops at the first package.json found on a branch (that is the package — its
// sources live below and are not separately installable); the symlink farm at `.plugins/node_modules`
// is skipped (those are host packages, not cached plugins).
async function scanCacheDir(dotPlugins: string, results: DiscoveryEntry[]): Promise<void> {
  try { await access(dotPlugins); } catch { return; }

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

    let isPackage = false;
    try { await access(path.join(dir, 'package.json')); isPackage = true; } catch { /* not a package root */ }
    if (isPackage && dir !== dotPlugins) {
      const rel    = path.relative(dotPlugins, dir).split(path.sep);
      const host   = rel[0] ?? '';
      const url    = `https://${host}/${rel.slice(1).join('/')}`;
      const type: PluginSource = host === 'raw.githubusercontent.com' ? 'github' : 'cdn';
      const found  = await inspectPluginDir(dir, url, { type, uri: url });
      if (found) { results.push(found); return; } // a real plugin root — don't descend into its sources
    }

    for (const entry of entries) {
      // A dot-directory in the cache is matbot's own bookkeeping, never a mirrored host: `.restore`
      // holds the copy a refresh set aside, and the walk below would report it as a plugin served from
      // a host called `.restore`.
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await walk(path.join(dir, entry.name));
    }
  };

  await walk(dotPlugins);
}

// Read the plugin's package.json description without importing the module — the
// confirmation prompt runs before the user has consented to install, so we must not
// execute untrusted plugin code to read manifest.description here. Bare npm names are
// not yet on disk, so they have no resolvable description until after install.
async function pkgDescriptionFromSpecifier(specifier: string, projectDir: string): Promise<string | undefined> {
  let dir: string;

  if (specifier.startsWith('file://')) {
    dir = path.dirname(fileURLToPath((specifier.split('?')[0]) ?? specifier));
  } else if (specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier)) {
    dir = path.resolve(projectDir, specifier);
  } else {
    return undefined; // bare npm package name — not installed yet, nothing to read
  }

  while (true) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { description?: string };
      if (pkg.description) return pkg.description;
    } catch { /* no package.json here, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Resolve a user-supplied handle to the loadable specifier recorded in matbot.yaml. A loaded plugin
// records its config entry as `plugin.specifier`, so the canonical package `name` maps straight to it
// via getSpecifierForPlugin — that's the stable, preferred handle. The literal config entry also works
// (it is its own specifier); anything else falls through unchanged so a direct specifier still loads.
function toConfigSpecifier(handle: string): string {
  const byName = getSpecifierForPlugin(handle);
  return byName ?? handle;
}

function normalizeRuntimes(raw: unknown): Runtime[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((r): r is Runtime => r === 'node' || r === 'browser');
}

// Why a manifest's `matbotRuntime` means this host must not install it, or undefined if it may. The field is
// what makes a package a matbot plugin before any of its code has run, on every route.
function runtimeRefusal(specifier: string, runtimes: readonly string[] | undefined): string | undefined {
  if (runtimes === undefined) {
    return `Refusing to install "${specifier}": its package.json has no "matbotRuntime" field, so it cannot be ` +
           `verified as a matbot plugin. The plugin tool installs plugins; a plugin's own npm dependencies come ` +
           `with it. Nothing was changed.`;
  }
  if (!runtimes.includes('node')) {
    return `Refusing to install "${specifier}": it declares matbotRuntime [${runtimes.join(', ')}], which excludes ` +
           `the "node" host. Nothing was changed.`;
  }
  return undefined;
}

function notAPackageName(specifier: string, spec: string): string {
  const versioned = spec.match(/^((?:@[^/@\s]+\/)?[^/@\s]+)@\S+$/);
  if (versioned?.[1] !== undefined && isPackageName(versioned[1])) {
    const name = versioned[1];
    return `"${specifier}" names a version. The plugin tool installs an npm plugin by its package name and leaves ` +
           `which version to the project: install it with your package manager (\`npm install ${spec}\`), then ` +
           `\`plugin add ${name}\` — or, if "${name}" is already a plugin here, \`plugin reload ${name}\` to run the ` +
           `version now installed. Nothing was changed.`;
  }
  return `"${specifier}" is not a package name. The plugin tool installs an npm plugin by its name; install a ` +
         `tarball or a git package with your package manager, then \`plugin add <its name>\`. A plugin's source can ` +
         `also be added directly from a github: or https URL. Nothing was changed.`;
}

// Read a plugin's canonical package.json `name` by walking up from the specifier — the same boundary
// the node PluginResolver uses, so a declaration on the plugin (not an enclosing monorepo root) wins.
// file://, paths, and (once installed) bare npm names resolve; a remote github:/https URL does not
// (→ undefined; callers holding a fetched manifest read its name directly).
async function nameFromSpecifier(specifier: string, projectDir: string): Promise<string | undefined> {
  let dir: string;
  if (specifier.startsWith('file://')) {
    dir = path.dirname(fileURLToPath((specifier.split('?')[0]) ?? specifier));
  } else if (specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier)) {
    dir = path.resolve(projectDir, specifier);
  } else {
    try {
      dir = path.dirname(createRequire(path.join(projectDir, '_')).resolve(specifier));
    } catch {
      return undefined;
    }
  }
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name) return pkg.name;
    } catch { /* no package.json here, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function readProviderModules(configPath: string): Promise<string[]> {
  const text = await readFile(configPath, 'utf8');
  return [...text.matchAll(/^\s+module:\s+['"]?([^\s'"]+)/gm)].map(m => m[1] ?? '').filter(Boolean);
}

async function detectPackageManager(dir: string): Promise<string> {
  for (const [pm, lockfile] of [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lockb']] as const) {
    try { await access(path.join(dir, lockfile)); return pm; } catch { /* not present */ }
  }
  return 'npm';
}

/** Extra `add` flags needed to install into `dir` itself.
 *
 *  `pnpm add` refuses at a workspace root (ERR_PNPM_ADDING_TO_ROOT) unless the root is named
 *  explicitly, on the assumption that a member package was meant. Here it never was: `dir` is where
 *  matbot.yaml lives, and a plugin is that project's dependency — there is no member package it could
 *  belong to instead. So say so, rather than failing an install that had nowhere else to go. */
async function addFlags(pm: string, dir: string): Promise<string[]> {
  if (pm !== 'pnpm') return [];
  try { await access(path.join(dir, 'pnpm-workspace.yaml')); return ['-w']; } catch { return []; }
}

// The configured specifiers, other than `except`, whose files are in the fetched-plugin cache — what
// `releaseRemote` must not delete from under. A provider's `module:` is materialised there as well, and
// counts even when it is the same specifier: removing the plugin does not remove the provider.
async function otherRemotes(configPath: string, projectDir: string, except: string): Promise<string[]> {
  const plugins = (await readPluginsList(configPath)).filter(spec => spec !== except);
  const remotes: string[] = [];
  for (const spec of new Set([...plugins, ...await readProviderModules(configPath)])) {
    if ((await classifySpecifier(spec, projectDir)).kind === 'http') remotes.push(spec);
  }
  return remotes;
}

// Take back, unasked, what an `add` that then disowns the plugin changed in the project: it aborts an
// install approved moments ago in the same call, rather than acting on something the user may still want.
// Only what the call itself was seen to create (install-record.ts) — never a dependency the project
// already declared, and never on the paths that keep the entry in config to retry (a missing secret, an
// unresolved dependency), where the plugin is installed, merely not working yet, and `remove` can reach it.
async function* takeBack(
  created: Omit<InstallRecord, 'entry'>, projectDir: string,
): AsyncGenerator<ToolEvent<ToolResultOf<'plugin'>>, void> {
  if (created.dependency !== undefined) {
    try {
      const out = await runCommand(await detectPackageManager(projectDir), ['remove', created.dependency], projectDir);
      yield { type: 'stdout', chunk: out || `Removed the "${created.dependency}" package again.\n` };
    } catch (e) {
      yield { type: 'stderr', chunk:
        `Could not remove the "${created.dependency}" package again (${String(e)}) — it is still in ` +
        `package.json, so remove it by hand.\n` };
    }
  }
  if (created.provisioned !== undefined) {
    const removed = await removeProvisioned(created.provisioned);
    if (removed.length > 0) yield { type: 'stdout', chunk: `Removed the ${removed.join(' and ')} its install created.\n` };
  }
}

const exists = async (p: string): Promise<boolean> => {
  try { await access(p); return true; } catch { return false; }
};

// Where `name` is installed for the project, by the directory walk a bare import makes — not a resolve, which
// would apply a require condition an ESM-only package's `exports` need not have.
async function installedPackageDir(name: string, projectDir: string): Promise<string | undefined> {
  for (let dir = path.resolve(projectDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (await exists(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

// `name@version` a package manager reports as unresolvable, when it names a package OTHER than the one
// being installed — so a dependency or peer whose RANGE resolved to a version no registry carries.
function unresolvedDependencyOf(raw: string, specifier: string): string | undefined {
  const m = raw.match(/No matching version found for ((?:@[^/\s]+\/)?[^@\s]+)@(\S+?)(?:[\s,]|$)/);
  if (m === null) return undefined;
  const [, name, version] = m;
  if (name === undefined || version === undefined) return undefined;
  // The specifier may carry its own range (`foo@^1`, `@scope/foo@1.2.3`); compare bare names.
  const asked = specifier.replace(/^(@[^/]+\/)?([^@]+).*$/, '$1$2');
  return name === asked ? undefined : `${name}@${version}`;
}

// Turn a raw package-manager failure into an actionable message: name the intent and translate the
// three signatures users actually hit (workspace-only source packages; a dependency resolved to a
// version only this workspace has; registry 404s) instead of dumping the exit code and stderr alone.
async function describeInstallFailure(specifier: string, pm: string, projectDir: string, e: unknown): Promise<string> {
  const raw = e instanceof Error ? e.message : String(e);
  let hint = '';
  const unresolved = unresolvedDependencyOf(raw, specifier);
  if (/workspace:|catalog:/i.test(raw)) {
    hint = ' This looks like a workspace-internal source package (it uses the workspace:/catalog: protocol) ' +
           'and cannot be installed standalone — install the published package, or point at its raw source via a URL / github: specifier.';
  } else if (unresolved !== undefined && await exists(path.join(projectDir, 'pnpm-workspace.yaml'))) {
    // Not the asked-for package: a DEPENDENCY (usually the plugin-api peer) resolved to a version the
    // registry does not carry, which is what happens when the version only exists in this workspace and
    // the package manager is not linking workspace packages — so it goes to the registry for it instead.
    // The registry advice below is actively wrong here: the name is right and the range is satisfiable.
    hint = ` "${unresolved}" is a dependency of it, not the package asked for, and that version looks like ` +
           `one only this workspace provides — so ${pm} went to the registry for a version only local source has. ` +
           `Check that workspace linking is on (pnpm >= 10 reads \`linkWorkspacePackages\` from pnpm-workspace.yaml, ` +
           `NOT from .npmrc, where it is silently ignored).`;
  } else if (/\b404\b|not found|No matching version/i.test(raw)) {
    hint = ' The package or version was not found in the configured registry (check the name, or the registry in your .npmrc).';
  }
  return `Could not install "${specifier}" with ${pm}:${hint}\n${raw}`;
}

/** If `e` is a module-resolution failure, the bare package specifier it couldn't find — else undefined.
 *  A raw github/URL fetch copies one plugin's own files, not its dependency graph, so a plugin with a
 *  runtime dependency on another package fails here with the package unresolved. We surface the package
 *  name so the caller can give one readable instruction instead of an opaque ERR_MODULE_NOT_FOUND that
 *  sends the model hunting for name variations.
 *
 *  BOTH wordings must match, and the second is the one that matters. Node's own message is
 *  `Cannot find package 'x' imported from …`, but a bare import from inside the `.plugins/` cache never
 *  reaches it: ts-hooks' `resolveAsHost` retries against the host's graph first and, when that also fails,
 *  throws its own `Cannot resolve "x" imported by …` carrying the same ERR_MODULE_NOT_FOUND code. Matching
 *  only Node's phrasing therefore missed every http plugin — precisely the route this exists for. */
export function missingPackageOf(e: unknown): string | undefined {
  // Walk the cause chain. The error reaching here is the loader's wrapper, not the import rejection, and
  // one layer forgetting to carry `code` made this return undefined for every http plugin — the failure
  // this exists to explain. Reading through the chain does not depend on every future wrapper
  // remembering.
  let cur: unknown = e;
  let found = false;
  for (let depth = 0; cur instanceof Error && depth < 8; depth++) {
    if ((cur as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') { found = true; break; }
    cur = (cur as { cause?: unknown }).cause;
  }
  if (!found || !(e instanceof Error)) return undefined;
  const m = /Cannot (?:find (?:package|module)|resolve) ['"]([^'"]+)['"]/.exec(e.message);
  const pkg = m?.[1];
  // A bare package specifier (not a relative/absolute path): that's a missing dependency, not a
  // broken internal import.
  return pkg !== undefined && !pkg.startsWith('.') && !pkg.startsWith('/') ? pkg : undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// A plugin contributes through several channels: static fields on the plugin object
// (provider, tools, storage, storageBackend, frontend) and runtime registrations made
// during setup() (tools, hooks, system-context contributors, and MatbotMachine keys such
// as 'KnowledgeIndex'). Reflect every channel so the reported type list is complete, not just
// the static ones.
function pluginTypes(p: MatbotPlugin, registeredToolPlugins: Set<string>): string[] {
  const t: string[] = [];
  const serviceKeys = getRegisteredServiceKeys(p.name);

  if (p.provider !== undefined)                                                   t.push('provider');
  if (p.tools?.length || registeredToolPlugins.has(p.name))                       t.push('tools');
  if (p.storageBackend !== undefined || serviceKeys.includes('StorageBackend'))   t.push('storage');
  if (getRegisteredFrontendPlugins().has(p.name))                                 t.push('frontend');
  if (getHookPlugins().has(p.name))                                               t.push('hooks');
  if (getSystemContextPlugins().has(p.name))                                      t.push('system-context');

  // Any other runtime-registered service (custom cognitive subsystems, domain backends).
  // 'KnowledgeIndex' and 'StorageBackend' are already surfaced as dedicated types above.
  t.push(...serviceKeys);

  if (!t.length) t.push('extension');
  return [...new Set(t)];
}

// ── Provisioning a fetched plugin's dependencies ──────────────────────────────
//
// Offer to install them, rather than only naming them — into the plugin's OWN cached directory under
// `.plugins/`, which is the same place the local route installs into and for the same reasons.
//
// NOT the project. `pnpm add` at a workspace root refuses outright (ERR_PNPM_ADDING_TO_ROOT, wanting
// `-w`), and where it succeeds it writes a fetched plugin's dependencies into the user's own manifest
// and lockfile — permanent, tracked, and nothing to do with their project. The cache directory has none
// of that: it is matbot's to write, gitignored, per-plugin, and it sits EARLIER in the resolution
// walk-up than the shared link farm, so what lands there is reachable from this plugin and invisible to
// everything else. Not the farm itself either, which holds the host singletons and the plugin
// self-links — an install there would prune them as extraneous.
//
// Reusing plan/apply rather than shelling out gets the rest for free: npm unconditionally (the cache dir
// is not in anyone's workspace, so pnpm's walk-up problem cannot arise), the full transitive set in the
// approval instead of just the direct names, and the host singletons linked afterwards. The approval is
// still an out-of-band human one, so a fetched plugin cannot install anything by asserting that it needs
// it.
//
// Every declared dependency is planned, not just the one that failed: activation stops at the FIRST
// unresolved import, so one-at-a-time would be a prompt-and-retry cycle per package.
//
// Shared by `add` and `reload` because it is one situation reached at two moments — a refresh can bring
// a dependency the fetched copy never had, and reload used to have no answer for that at all. The
// outcome is returned rather than reported: the two callers are reporting different things (an install
// that did not finish, a reload that did not take), and a tool frames itself.
type DepProvision =
  | { outcome: 'none' }                                  // nothing declared that npm would install
  | { outcome: 'unresolved'; reason: string }            // npm could not say what it would install
  | { outcome: 'declined' }
  | { outcome: 'failed';    reason: string }             // the install itself failed
  | { outcome: 'installed'; packages: number };

async function* provisionRemoteDependencies(
  ctx: ToolContext, specifier: string, projectDir: string,
): AsyncGenerator<ToolEvent<ToolResultOf<'plugin'>>, DepProvision> {
  let plan: ProvisionPlan;
  try {
    const m = await materializeRemote(specifier, path.join(projectDir, '.plugins'), projectDir);
    plan = await planProvision(m.pkgRoot);
  } catch (err) {
    return { outcome: 'unresolved', reason: err instanceof Error ? err.message : String(err) };
  }
  if (plan.packages.length === 0) return { outcome: 'none' };

  const offer = await ctx.gate({
    gate:     'provision-deps',
    subject:  specifier,
    fallback: false,
    label:
      `**"${specifier}"** needs packages a source-fetch does not bring in (it copies a plugin's own ` +
      `files, not its dependency graph). Install ${plan.packages.length} package(s) into its cache ` +
      `directory?\n${plan.packages.map(pkg => `- ${pkg}`).join('\n')}`,
  });
  if (!offer.allowed) {
    await discardProvision(plan);
    return { outcome: 'declined' };
  }

  yield { type: 'stdout', chunk: `Installing ${plan.packages.length} package(s) with npm...\n` };
  try {
    const { linked, output } = await applyProvision(plan);
    if (output) yield { type: 'stdout', chunk: output };
    if (linked.length > 0) yield { type: 'stdout', chunk: `Linked the host's ${linked.join(', ')}.\n` };
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  return { outcome: 'installed', packages: plan.packages.length };
}

// ── Input types ───────────────────────────────────────────────────────────────

type PluginInput =
  | { action: 'list' }
  | { action: 'add';            specifier: string }
  | { action: 'remove';         specifier: string }
  | { action: 'reload';         specifier: string; refresh?: boolean }
  | { action: 'store-key';      key: string }
  | { action: 'discover_local' };

// ── Executor ──────────────────────────────────────────────────────────────────

const executor: ToolExecutor<ToolResultOf<'plugin'>> = {
  async *execute(input: unknown, ctx: ToolContext) {
    const { action } = input as PluginInput;

    const configPath = ctx.configPath;
    if (!configPath) {
      yield { type: 'error', message: 'No config path in tool context — cannot manage plugins.' };
      return;
    }
    const projectDir = path.dirname(configPath);

    // ── list ─────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const configured = await readPluginsList(configPath);
      const allTools   = getRegisteredTools();

      // Group tools by owning plugin (undefined = built-in / unattributed)
      const toolsByPlugin = new Map<string | undefined, { name: string; description: string }[]>();
      for (const t of allTools) {
        const key  = t.pluginName;
        const list = toolsByPlugin.get(key) ?? [];
        list.push({ name: t.name, description: t.description });
        toolsByPlugin.set(key, list);
      }

      const pluginToolNames = new Set(
        [...toolsByPlugin.keys()].filter((k): k is string => k !== undefined),
      );

      const loaded = getRegisteredPlugins().map(p => ({
        name:        p.name,
        apiVersion:  p.apiVersion,
        types:       pluginTypes(p, pluginToolNames),
        tools:       toolsByPlugin.get(p.name) ?? [],
        specifier:   p.specifier,
        ...(p.version       !== undefined ? { version:       p.version }       : {}),
        ...(p.resolvedUrl   !== undefined ? { resolvedUrl:   p.resolvedUrl }   : {}),
        ...(p.manifest?.description ? { description: p.manifest.description } : {}),
        ...(p.matbotRuntime !== undefined ? { matbotRuntime: p.matbotRuntime } : {}),
      }));

      const failed = getFailedPlugins();
      // Reported alongside failures because it is the same kind of fact — something about the installed
      // set that is worth knowing and that nothing else would ever mention. It is not a failure: a second
      // copy of a singleton is survivable by design, which is exactly why it would otherwise go unnoticed.
      const duplicateSingletons = await findDuplicateSingletons({ configDir: projectDir, plugins: loaded });

      yield {
        type:  'result',
        value: {
          loaded,
          configured,
          ...(failed.length ? { failed: failed.map(f => ({ specifier: f.specifier, error: f.error, ...(f.name !== undefined ? { name: f.name } : {}) })) } : {}),
          ...(toolsByPlugin.has(undefined) ? { builtinTools: toolsByPlugin.get(undefined) } : {}),
          ...(duplicateSingletons.length ? { duplicateSingletons } : {}),
        },
      };
      return;
    }

    // ── discover_local ────────────────────────────────────────────────────────
    if (action === 'discover_local') {
      const found           = await discoverLocalPlugins(projectDir);
      const pluginEntries   = new Set(await readPluginsList(configPath));
      const providerModules = new Set(await readProviderModules(configPath));
      yield {
        type:  'result',
        value: found.map(p => ({
          ...p,
          configuredVia: configuredIn(pluginEntries, p, projectDir) ? 'plugins'
                       : configuredIn(providerModules, p, projectDir) ? 'providers'
                       : null,
        })),
      };
      return;
    }

    // ── store-key ──────────────────────────────────────────────────────────────
    // A plugin or provider that needs a secret raises MissingSecretError naming the
    // key; call this to supply it. The value is requested out-of-band via ctx.prompt
    // so it never enters the conversation transcript, then stored in the vault. An
    // empty value is the removal signal — leaving the prompt blank deletes the key.
    if (action === 'store-key') {
      const { key } = input as { action: 'store-key'; key: string };
      if (!key || !key.trim()) {
        yield { type: 'error', message: 'store-key requires a "key" name.' };
        return;
      }
      const name    = key.trim();
      const value   = await ctx.prompt(`Enter the value for secret "${name}" (leave blank to remove it; not added to the conversation):`, '');
      const trimmed = value.trim();
      // writeSecret, not createSecret: this answers a MissingSecretError naming an exact key,
      // so the value must land under that name verbatim — no reference/dedup canonicalisation.
      // An empty value is writeSecret's removal signal.
      const existed = trimmed === '' && ctx.vault.hasKey(name);
      await ctx.vault.writeSecret(name, trimmed);
      yield { type: 'result', value: { message:
        trimmed !== '' ? `Secret "${name}" stored in the vault.`
        : existed       ? `Secret "${name}" removed from the vault.`
        :                 `No value entered and no secret named "${name}"; nothing changed.` } };
      return;
    }

    const { specifier } = input as { action: string; specifier: string };

    // ── add ──────────────────────────────────────────────────────────────────
    // `specifier` is a concrete npm name / path / GitHub shorthand / CDN URL. Resolving a fuzzy
    // human name ("install the mcp plugin") to a specifier is the model's job (it can run
    // `discover_local` first), not the tool's — there is no fuzzy-match step here.
    if (action === 'add') {
      const existing = await readPluginsList(configPath);
      if (existing.includes(specifier)) {
        yield { type: 'result', value: { message: `"${specifier}" is already configured.` } };
        return;
      }

      // The host runtime packages are not plugins — they are the shared singletons every plugin
      // peer-depends on, always already present. The model sometimes tries to "install" them (often
      // with a version suffix, e.g. `@matatbread/matbot-plugin-api@latest`); refuse so they never
      // land in the config as a bogus, unloadable entry.
      if (/^@matatbread\/matbot-(plugin-api|core)(@|$)/.test(specifier)) {
        yield { type: 'error', message:
          `"${specifier}" is a host runtime package (a shared matbot singleton), not a plugin — it is ` +
          `already present and cannot be installed. Nothing was changed.` };
        return;
      }

      // Classification is grounded in what is actually on disk (a stat), not just the string shape:
      // a bare `plugins/foo` is local iff it exists, and a `./`-/`/`-shaped path with no
      // package.json is reported rather than silently mis-installed.
      const classified = await classifySpecifier(specifier, projectDir);
      if (classified.kind === 'missing-path') {
        yield { type: 'error', message:
          `"${specifier}" looks like a local path but no package.json was found at "${classified.resolved}" ` +
          `or any parent directory. Check the path, or pass an npm name, URL, or github: specifier.` };
        return;
      }

      // Everything that can refuse is decided here, before anyone is asked and before anything is written:
      // which package this is, under which name, and whether that name is free. An install that could not be
      // carried through — or taken back exactly — is refused with what to do instead, rather than attempted
      // and then undone by inference.
      let description: string | undefined;
      let pluginName: string | undefined;
      let configSpecifier = specifier;

      // Pre-fetch verification for remote (raw-source) plugins: confirm the package.json declares
      // matbotRuntime including "node" BEFORE downloading or executing any code, so a stray URL
      // cannot be installed.
      if (classified.kind === 'http') {
        if (classified.advice !== undefined) yield { type: 'stdout', chunk: `${classified.advice}\n` };
        try {
          const manifest = await fetchRemoteManifest(specifier, path.join(projectDir, '.plugins'), /* live */ true);
          const refusal = runtimeRefusal(specifier, manifest.runtimes);
          if (refusal !== undefined) {
            yield { type: 'error', message: refusal };
            return;
          }
          const d = manifest.pkg['description'];
          if (typeof d === 'string') description = d;
          if (typeof manifest.pkg['name'] === 'string') pluginName = manifest.pkg['name'];
        } catch (e) {
          yield { type: 'error', message: `Could not install "${specifier}": ${e instanceof Error ? e.message : String(e)}.` };
          return;
        }
      }

      // The npm route installs a PLUGIN, by its package name, and reads that package's manifest first — the
      // copy already installed if there is one, else the registry's — so a package that is not a matbot
      // plugin is refused before it is installed, exactly as a URL that is not one is. A version, a tarball
      // or a git URL is refused: which copy of a package the project carries is the project's decision, made
      // with its own package manager, and each of them made what this call installed something it could only
      // guess at afterwards.
      let npmInstall: { pm: string } | undefined;
      if (classified.kind === 'npm') {
        const name = classified.spec;
        if (!isPackageName(name)) {
          yield { type: 'error', message: notAPackageName(specifier, name) };
          return;
        }
        // The entry recorded is the bare name, so with `npm:` forcing past something local that answers to it,
        // the next start would load that instead of what was installed.
        if (specifier !== name && (await classifySpecifier(name, projectDir)).kind !== 'npm') {
          yield { type: 'error', message:
            `Not installing "${name}": something in this project also answers to that name (a directory, or a ` +
            `local package declaring it), and the entry recorded in ${path.basename(configPath)} is the name — ` +
            `so the next start would load that instead of the installed package. Rename or move the local one, ` +
            `or add it by its path if it is the one you mean. Nothing was changed.` };
          return;
        }
        let manifest: Record<string, unknown>;
        const installedAt = await installedPackageDir(name, projectDir);
        if (installedAt !== undefined) {
          try {
            manifest = JSON.parse(await readFile(path.join(installedAt, 'package.json'), 'utf8')) as Record<string, unknown>;
          } catch (e) {
            yield { type: 'error', message: `Could not read the installed "${name}" at ${installedAt}: ${e instanceof Error ? e.message : String(e)}.` };
            return;
          }
        } else {
          // Installing writes the project's package.json, so there has to be one here: without it the package
          // manager writes whichever an enclosing directory has, which this call never read.
          const before = await declaredDependencies(projectDir);
          if (before === undefined) {
            yield { type: 'error', message:
              `Not installing "${name}": there is no package.json in ${projectDir}, so a package manager would ` +
              `record it in whichever enclosing directory has one. Create one there (\`npm init -y\`), or install ` +
              `"${name}" yourself, then add it again. Nothing was changed.` };
            return;
          }
          if (before.has(name)) {
            yield { type: 'error', message:
              `Not installing "${name}": the project's package.json already declares it, but it is not installed. ` +
              `Run \`${await detectPackageManager(projectDir)} install\` in ${projectDir}, then add it again. Nothing was changed.` };
            return;
          }
          try {
            manifest = await registryManifest(name, projectDir);
          } catch (e) {
            yield { type: 'error', message: `Could not install "${name}": ${e instanceof Error ? e.message : String(e)}. Nothing was changed.` };
            return;
          }
          npmInstall = { pm: await detectPackageManager(projectDir) };
        }
        const refusal = runtimeRefusal(name, normalizeRuntimes(manifest['matbotRuntime']));
        if (refusal !== undefined) {
          yield { type: 'error', message: refusal };
          return;
        }
        const d = manifest['description'];
        if (typeof d === 'string') description = d;
        pluginName = name;
        configSpecifier = name;
      }

      // A path is the least portable thing this could record: it is right only for this working copy,
      // while the name resolves here AND in an installed deployment, and is the handle remove/reload
      // address the plugin by. So record the name whenever it resolves back to the directory just
      // approved — the same rule the `provider` tool and the setup wizard already follow.
      if (classified.kind === 'local') {
        description = await pkgDescriptionFromSpecifier(classified.dir, projectDir);
        pluginName = await nameFromSpecifier(classified.dir, projectDir);
        const named = await canonicalLocalSpecifier(classified.dir, projectDir);
        if (named !== undefined) configSpecifier = named;
      }

      if (configSpecifier !== specifier && existing.includes(configSpecifier)) {
        yield { type: 'result', value: { message: `"${specifier}" is already configured, as "${configSpecifier}".` } };
        return;
      }

      // Duplicate-name guard: a plugin's canonical package.json `name` is its identity (and the handle
      // remove/reload address it by), and the registry forbids two loaded plugins sharing one. Almost always
      // the same package added by two specifiers: a config error, not something to silently double-install.
      if (pluginName !== undefined) {
        const clash = getRegisteredPlugins().find(p => p.name === pluginName);
        if (clash !== undefined) {
          yield { type: 'error', message:
            `A plugin named "${pluginName}" is already installed (from "${clash.specifier}"). Remove it first, or — ` +
            `if this is the same package via a different specifier — keep the one you have. To run another ` +
            `version of an npm plugin, install that version with your package manager and \`plugin reload ` +
            `${pluginName}\`. Nothing was changed.` };
          return;
        }
      }

      // A local plugin brings its own dependencies. Where its directory is empty ground they are resolved
      // BEFORE asking — npm's `--package-lock-only` answers "what would this install" without putting a
      // package on disk — so the transitives appear in the approval the user is already being asked for,
      // rather than as a second prompt for consequences of the first. Where the author has installed into
      // it, that install is theirs: complete, it is used as it is, and otherwise they are asked to finish it.
      let plan: ProvisionPlan | undefined;
      if (classified.kind === 'local') {
        const state = await localProvision(classified.dir);
        if ('refuse' in state) {
          yield { type: 'error', message: `Not installing "${specifier}": ${state.refuse}. Nothing was changed.` };
          return;
        }
        if (state.provision) {
          try {
            plan = await planProvision(classified.dir);
          } catch (e) {
            yield { type: 'error', message:
              `Could not resolve the dependencies of "${specifier}": ${e instanceof Error ? e.message : String(e)}. ` +
              `Nothing was changed in ${path.basename(configPath)}.` };
            return;
          }
          if (plan.unsupported.length > 0) {
            // Not a failure: these are workspace/link/file protocols, which say "something already resolves
            // me" — every in-repo plugin looks like this. Say so once, then install as before.
            const ranges = plan.unsupported.map(u => `${u.name}@${u.range}`).join(', ');
            yield { type: 'stdout', chunk:
              `Leaving dependencies to their own resolution (${ranges}) — not registry ranges, so npm is not asked.\n` };
          }
        }
      }

      // A gate rather than a `confirmed` input parameter: plugin installation is a privileged
      // operation. Breaking the LLM's execution chain and requiring an out-of-band human response
      // prevents prompt injection or a malicious plugin from auto-installing further plugins by simply
      // passing confirmed:true. The SUBJECT is the specifier as typed — at this point the plugin is not
      // loaded, so a policy remembering an answer keys on the spelling, and `@x/foo` and
      // `https://…/foo.ts` are deliberately different decisions.
      const deps = plan !== undefined && plan.packages.length > 0
        ? `\n\nIt will also install ${plan.packages.length} package(s) from npm:\n${plan.packages.map(p => `- ${p}`).join('\n')}`
        : '';
      const confirmed = await ctx.gate({
        gate:     'add',
        subject:  specifier,
        fallback: false,
        label:    `Install plugin **"${specifier}"**?${description !== undefined ? `\n_${description}_` : ''}${deps}`,
      });
      if (!confirmed.allowed) {
        if (plan !== undefined) await discardProvision(plan);
        yield { type: 'result', value: { message: refusalMessage(confirmed) } };
        return;
      }

      // What this call changes outside matbot's own cache, as it changes it: written to the install record
      // once the entry is in config, and taken back if the plugin is then disowned.
      const created: Omit<InstallRecord, 'entry'> = {};
      const dotPlugins = path.join(projectDir, '.plugins');

      if (plan !== undefined && plan.packages.length === 0) await discardProvision(plan);
      if (plan !== undefined && plan.packages.length > 0) {
        yield { type: 'stdout', chunk: `Installing ${plan.packages.length} dependency package(s) with npm...\n` };
        // Provisioning only ever runs on empty ground (`localProvision`), so all of this is the call's own.
        const provisioned = { dir: plan.dir, lockfile: plan.createdLockfile, nodeModules: !plan.hadNodeModules };
        try {
          const { linked, output } = await applyProvision(plan);
          created.provisioned = provisioned;
          if (output) yield { type: 'stdout', chunk: output };
          if (linked.length > 0) yield { type: 'stdout', chunk: `Linked the host's ${linked.join(', ')}.\n` };
        } catch (e) {
          await removeProvisioned(provisioned);
          yield { type: 'error', message:
            `Could not install the dependencies of "${specifier}": ${e instanceof Error ? e.message : String(e)}. ` +
            `What the attempt wrote in ${plan.dir} was removed, and nothing was changed in ${path.basename(configPath)}.` };
          return;
        }
      }

      if (npmInstall !== undefined) {
        const { pm } = npmInstall;
        yield { type: 'stdout', chunk: `Installing "${configSpecifier}" with ${pm}...\n` };
        try {
          const out = await runCommand(pm, ['add', ...await addFlags(pm, projectDir), configSpecifier], projectDir);
          if (out) yield { type: 'stdout', chunk: out };
        } catch (e) {
          yield { type: 'error', message: await describeInstallFailure(configSpecifier, pm, projectDir, e) };
          return;
        }
        // Not declared before (checked above), so declared now means this call put it there.
        if ((await declaredDependencies(projectDir))?.has(configSpecifier) === true) created.dependency = configSpecifier;
      }

      await addPlugin(configPath, configSpecifier);
      await writeInstallRecord(dotPlugins, { entry: configSpecifier, ...created });

      // A plugin that turns out not to be one is disowned: out of config, and everything this call put
      // anywhere taken back — the project's files, and a fetched plugin's cache.
      const disown = async function* (): AsyncGenerator<ToolEvent<ToolResultOf<'plugin'>>, void> {
        await removePlugin(configPath, configSpecifier);
        yield* takeBack(created, projectDir);
        await dropInstallRecord(dotPlugins, configSpecifier);
        if (classified.kind === 'http') {
          await releaseRemote(configSpecifier, dotPlugins, await otherRemotes(configPath, projectDir, configSpecifier));
        }
      };

      // For a remote specifier, loadPlugin materialises the module graph into .plugins/ first.
      yield { type: 'stdout', chunk: `Activating "${configSpecifier}"...\n` };
      try {
        const loaded  = await ctx.loadPlugin(configSpecifier);
        const welcome = await loaded.installationMessage?.();
        yield {
          type:  'result',
          value: {
            message: `"${configSpecifier}" installed and is now active.`,
            ...(welcome !== undefined ? { installationMessage: welcome } : {}),
          },
        };
      } catch (e) {
        // A runtime mismatch (wrong host) or a not-plugin-shaped module (a library) is permanent for
        // this specifier, not a fixable hiccup: roll it back out of matbot.yaml so the config never
        // carries an entry that can never activate. Other activation failures (e.g. a missing secret)
        // are left in config to fix and retry.
        if (isIncompatibleRuntimeError(e)) {
          yield* disown();
          yield { type: 'error', message: e.message };
          return;
        }
        // Definitive, not retryable: state the conclusion ("not a matbot plugin") rather than echoing
        // the loader's `reason`, which reads as a code-fix instruction ("Expected: export const plugin")
        // an LLM may try to act on by editing the library's source.
        if (isNotAPluginError(e)) {
          yield* disown();
          yield { type: 'error', message:
            `"${configSpecifier}" is not a matbot plugin — it exports no \`plugin\`, so it cannot be installed ` +
            `(it is most likely a library). Nothing was changed in ${path.basename(configPath)}.` };
          return;
        }
        // A raw github/URL fetch installs ONE plugin's files, not its dependency graph. A plugin with a
        // runtime dependency on another package therefore fails with that package unresolved. State the
        // remedy plainly — install the dependency too — instead of surfacing the raw module-not-found,
        // which makes the model hunt for npm name variations. The entry is LEFT in config (it activates
        // once the dependency is present), like any other fixable activation failure.
        const missing = classified.kind === 'http' ? missingPackageOf(e) : undefined;
        if (missing !== undefined) {
          const dep = yield* provisionRemoteDependencies(ctx, specifier, projectDir);
          if (dep.outcome === 'unresolved') {
            yield { type: 'stdout', chunk: `Could not resolve "${configSpecifier}"'s dependencies: ${dep.reason}\n` };
          }
          if (dep.outcome === 'failed') {
            yield { type: 'result', value: { message:
              `Could not install the dependencies of "${configSpecifier}": ${dep.reason}. ` +
              `It has been left in ${path.basename(configPath)} and activates once they are present.` } };
            return;
          }
          if (dep.outcome === 'installed') {
            // Retried in process: the files are already cached, so this is a resolution retry and not a
            // second fetch. A failure here is reported as-is — what was asked for is now installed, so
            // whatever remains is a different problem and guessing at it would mislead.
            yield { type: 'stdout', chunk: `Activating "${configSpecifier}"...\n` };
            try {
              const loaded  = await ctx.loadPlugin(configSpecifier);
              const welcome = await loaded.installationMessage?.();
              yield { type: 'result', value: {
                message: `"${configSpecifier}" installed and is now active (${dep.packages} dependency package(s) installed).`,
                ...(welcome !== undefined ? { installationMessage: welcome } : {}),
              } };
            } catch (err) {
              yield { type: 'result', value: { message:
                `Installed its dependencies, but "${configSpecifier}" still did not activate: ${String(err)}. ` +
                `It has been left in ${path.basename(configPath)}.` } };
            }
            return;
          }

          const fromNpm = missing.startsWith('@matatbread/')
            ? `Installing it from npm is simplest — \`${missing}\` — because npm resolves ITS dependencies too.`
            : `Install \`${missing}\` (e.g. from npm) so it is present.`;
          yield { type: 'result', value: { message:
            `"${configSpecifier}" was fetched, but it depends on "${missing}", which a raw github/URL fetch does ` +
            `not bring in — source-fetch copies a plugin's own files, not its dependency graph. ${fromNpm} ` +
            `Then "${configSpecifier}" activates (it has been left in ${path.basename(configPath)}). Do not retry ` +
            `name variations — the dependency is genuinely missing, not misnamed.` } };
          return;
        }
        yield { type: 'result', value: { message: `"${configSpecifier}" added to config but activation failed: ${String(e)}.` } };
      }
      return;
    }

    // ── remove ───────────────────────────────────────────────────────────────
    if (action === 'remove') {
      const existing = await readPluginsList(configPath);
      // Address a plugin by its canonical package name (preferred) or its exact matbot.yaml entry.
      const entry = toConfigSpecifier(specifier);
      if (!existing.includes(entry)) {
        yield { type: 'result', value: { message: `"${specifier}" is not an installed plugin — pass its package name or its matbot.yaml entry (see \`plugin list\`).` } };
        return;
      }

      // Same security rationale as add: out-of-band prompt, not a confirmable parameter.
      const permit = await ctx.gate({ gate: 'remove', subject: entry, fallback: false,
                                      label: `Remove plugin **"${entry}"**?` });
      if (!permit.allowed) {
        yield { type: 'result', value: { message: refusalMessage(permit) } };
        return;
      }

      const removed = await removePlugin(configPath, entry);
      if (!removed) {
        yield { type: 'error', message: `Failed to remove "${entry}" from ${path.basename(configPath)}.` };
        return;
      }

      // A configured plugin that never loaded (a bad path, an incompatible runtime, a setup() throw)
      // has a recorded load failure but no live registration. Removing it from config must also drop
      // that failure record, or it lingers in `plugin list` / the web UI as a ghost with no config entry.
      clearFailedPlugin(entry);

      // Capture the canonical package name before deactivation drops it from the registry: it names the
      // package in what is said below. Falls back to a disk walk for a configured-but-unloaded plugin.
      const pkgName = getPluginNameForSpecifier(entry) ?? await nameFromSpecifier(entry, projectDir);
      const dotPlugins = path.join(projectDir, '.plugins');
      const record = await readInstallRecord(dotPlugins, entry);

      yield { type: 'stdout', chunk: `Deactivating "${entry}"...\n` };
      try {
        await ctx.unloadPlugin(entry);
      } catch (e) {
        yield { type: 'stderr', chunk: `Deactivation failed: ${String(e)}\n` };
      }

      // A fetched plugin's cache is matbot's own, and the plugin is gone: its source, the dependencies
      // installed into it, a set-aside copy and its name link go with it, unasked. Left, the name link kept
      // a removed plugin importable by name.
      if ((await classifySpecifier(entry, projectDir)).kind === 'http'
          && await releaseRemote(entry, dotPlugins, await otherRemotes(configPath, projectDir, entry))) {
        yield { type: 'stdout', chunk: `Removed its cached copy and installed dependencies from .plugins/.\n` };
      }

      // What `add` changed in the PROJECT is offered back, and only what the install record says `add`
      // created. Whether the project declares the package now is no evidence of who put it there: read that
      // way, `remove` offered to uninstall a project's own peer dependency.
      if (record?.dependency !== undefined) {
        const offer = await ctx.gate({ gate: 'npm-uninstall', subject: record.dependency, fallback: false,
                                       label: `Also uninstall the npm package **"${record.dependency}"** that adding the plugin installed?` });
        if (offer.allowed) {
          try {
            const out = await runCommand(await detectPackageManager(projectDir), ['remove', record.dependency], projectDir);
            if (out) yield { type: 'stdout', chunk: out };
          } catch (e) {
            yield { type: 'stderr', chunk: `Uninstall failed: ${String(e)}\n` };
          }
        }
      } else if (pkgName !== undefined && (await declaredDependencies(projectDir))?.has(pkgName) === true) {
        yield { type: 'stdout', chunk:
          `"${pkgName}" stays in package.json: no record says \`plugin add\` installed it, so it is the project's ` +
          `to remove (\`${await detectPackageManager(projectDir)} remove ${pkgName}\`).\n` };
      }
      if (record?.provisioned !== undefined) {
        const what = [record.provisioned.nodeModules ? 'node_modules' : '', record.provisioned.lockfile ? 'package-lock.json' : '']
          .filter(Boolean).join(' and ');
        if (what !== '') {
          const offer = await ctx.gate({ gate: 'remove-provisioned', subject: record.provisioned.dir, fallback: false,
                                         label: `Also delete the ${what} that adding the plugin created in **${record.provisioned.dir}**?` });
          if (offer.allowed) {
            const removed = await removeProvisioned(record.provisioned);
            yield { type: 'stdout', chunk: `Removed ${removed.join(' and ')} from ${record.provisioned.dir}.\n` };
          }
        }
      }
      await dropInstallRecord(dotPlugins, entry);

      yield { type: 'result', value: { message: `"${entry}" removed and deactivated.` } };
    }

    // ── reload ────────────────────────────────────────────────────────────────
    if (action === 'reload') {
      // Accept the canonical package name or the matbot.yaml entry; a not-yet-loaded direct specifier
      // falls through unchanged (the first-time-load path below).
      const entry = toConfigSpecifier(specifier);
      yield { type: 'stdout', chunk: `Reloading "${entry}"...\n` };

      let wasLoaded: boolean;
      try {
        wasLoaded = await ctx.unloadPlugin(entry);
      } catch (e) {
        // teardown() failed (e.g. timeout) — the plugin was resident, so this is still a
        // genuine reload of already-trusted code; surface the error but proceed.
        yield { type: 'stderr', chunk: `${String(e)}\n` };
        wasLoaded = true;
      }

      // Reloading a resident plugin needs no confirmation — the user already trusts it. But if
      // nothing was unloaded, "reload" is really a first-time load of code they haven't consented
      // to, so gate it with the same confirmation as add/remove.
      if (!wasLoaded) {
        const permit = await ctx.gate({ gate: 'load', subject: entry, fallback: false,
                                        label: `Plugin **"${entry}"** is not currently loaded — load it now?` });
        if (!permit.allowed) {
          yield { type: 'result', value: { message: refusalMessage(permit) } };
          return;
        }
      }

      // Default refresh=true: for a remote (github/http) plugin, reload means "pick up the latest
      // upstream source" — the cross-source analog of how a local reload always reflects on-disk edits.
      // Pass refresh:false to re-run setup() against the cached copy (e.g. to reset state, or offline).
      const { refresh = true } = input as { refresh?: boolean };
      const dotPlugins = path.join(projectDir, '.plugins');
      // Only a fetched plugin has a refresh to undo: a local reload reflects on-disk edits and an npm one
      // re-imports node_modules, neither of which this path writes to or evicts.
      const refreshed = refresh && (await classifySpecifier(entry, projectDir)).kind === 'http';

      // Two attempts at most, and the second never refreshes: the files are already cached, so it is a
      // resolution retry and not a second fetch — and a second eviction would discard the copy set aside
      // for the rollback below.
      let failure: unknown;
      let installed = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const reloaded = await ctx.loadPlugin(entry, attempt === 0 && refresh);
          if (refreshed) await discardRestore(entry, dotPlugins);
          const extra  = installed > 0 ? ` (${installed} dependency package(s) installed)` : '';
          const result = await reloaded.installationMessage?.() || `"${entry}" reloaded successfully${extra}.`;
          if (result !== null) {
            yield { type: 'result', value: { message: result } };
          }
          return;
        } catch (e) {
          failure = e;
          // A refreshed source can declare a dependency the cached copy never had, and a raw fetch brings
          // none: the same offer `add` makes, since this is the same situation reached later.
          if (attempt > 0 || !refreshed || missingPackageOf(e) === undefined) break;
          const dep = yield* provisionRemoteDependencies(ctx, entry, projectDir);
          if (dep.outcome === 'failed') {
            yield { type: 'stderr', chunk: `Could not install its dependencies: ${dep.reason}\n` };
          }
          if (dep.outcome !== 'installed') break;
          installed = dep.packages;
        }
      }

      // A refresh replaces the cached source, so by now the copy that WAS working is no longer what is on
      // disk — without putting it back, a failed reload is an outage and not a no-op: the plugin stays
      // unloaded and its tools are simply gone.
      if (refreshed && await restoreRemote(entry, dotPlugins)) {
        try {
          await ctx.loadPlugin(entry);
          yield { type: 'result', value: { message:
            `"${entry}" did not reload: ${String(failure)}. The previously cached copy has been restored and is ` +
            `active again, so nothing was lost — fix the cause upstream and reload again.` } };
        } catch (err) {
          yield { type: 'error', message:
            `"${entry}" did not reload: ${String(failure)}. The previously cached copy was restored but did not ` +
            `load either (${String(err)}), so the plugin is not running.` };
        }
        return;
      }

      // Nothing to put back on the other routes: a local plugin's source is whatever is on disk and an
      // npm one's is in node_modules, both untouched here — so the fix is theirs and a reload picks it up.
      yield { type: 'error', message: wasLoaded
        ? `"${entry}" did not reload, and is no longer loaded: ${String(failure)}.`
        : `"${entry}" did not load: ${String(failure)}.` };
    }
  },
};

// ── Tool definition ───────────────────────────────────────────────────────────

export const pluginTool: Tool<ToolResultOf<'plugin'>> = {
  name:        'plugin',
  description:
    'Manage matbot plugins — the units that contribute tools, providers, storage, hooks, and ' +
    'frontends to the running process. List or discover them, install or remove one, reload one ' +
    'to pick up code changes without restarting, or supply a secret a plugin or provider ' +
    'reported missing.\n\n' +
    'A `specifier` (for add/remove/reload) takes exactly one of THREE routes — local, npm, or http — ' +
    'each a set of spellings for the same mechanism. Pass a concrete string, not a fuzzy name (run ' +
    '`discover_local` first to find the exact specifier). If the user gives you a specifier, pass it ' +
    'through VERBATIM — never reformat it (especially a github: one):\n' +
    '```ts\n' +
    'type Specifier =\n' +
    '  // LOCAL — anything the disk already answers, PREFERRED over the registry. A path (resolved\n' +
    '  //   against the project dir; a package.json MUST exist at/above it — the leading "./" is\n' +
    '  //   optional), or a bare package NAME that a local package declares: in a source checkout\n' +
    '  //   "@matatbread/matbot-edit-session" is `plugins/edit-session`, and is used in place rather\n' +
    '  //   than installing a published copy of code already here.\n' +
    '  | "./<dir>" | "../<dir>" | "/<abs-dir>" | "file:///<abs-dir>" | "<dir>/<subdir>"\n' +
    '  | "<name>" | "@<scope>/<name>"            // when a local package declares that name\n' +
    '  // NPM — a package NAME nothing local claims (the registry, via your .npmrc: npmjs, verdaccio,\n' +
    '  //   private). Its manifest is read first and must declare matbotRuntime including "node". NAME\n' +
    '  //   ONLY: a "@<version>", a .tgz or a git URL is refused — which copy the project carries is its\n' +
    '  //   own decision; the user installs it with their package manager, then you add it by name.\n' +
    '  //   "npm:<name>" asks for the same; it is refused if something local also answers to the name.\n' +
    '  | "<name>" | "@<scope>/<name>"            // e.g. "@matatbread/matbot-persist-ki-bge"\n' +
    '  | "npm:<name>" | "npm:@<scope>/<name>"\n' +
    '  // HTTP — raw source, fetched & cached into .plugins/. MUST resolve a package.json: the URL is\n' +
    '  //   one, OR points at a directory containing one, OR is a code entry with one as its DIRECT\n' +
    '  //   SIBLING. "github:" is shorthand for this same route — use it for matbot source plugins,\n' +
    '  //   including one in a repo subdir; its "#<ref>" (branch/tag/commit) comes LAST, after "/<subdir>".\n' +
    '  | "https://<host>/<path>/" | "https://<host>/<path>/package.json"\n' +
    '  | "https://<host>/<path>/<entry>.ts"\n' +
    '  | "github:<owner>/<repo>" | "github:<owner>/<repo>/<subdir>"\n' +
    '  | "github:<owner>/<repo>#<ref>" | "github:<owner>/<repo>/<subdir>#<ref>";\n' +
    '```\n' +
    'Raw-source (HTTP/github) installs are packages: a package.json must resolve (the URL itself, a ' +
    'directory containing one, or — for a code-entry URL — its direct sibling), it must declare a "name", ' +
    'and its `matbotRuntime` must include "node"; the install is refused otherwise. ' +
    'Cached code lives read-only under `.plugins/`.\n\n' +
    'DEPENDENCY RESOLUTION BY SOURCE — decisive when a plugin depends on OTHER packages:\n' +
    '  • An npm name installs through the package manager, which resolves the FULL dependency tree. A ' +
    'package the project already has installed is configured as it is.\n' +
    '  • A local plugin (a path, or a name it declares) whose directory has no node_modules and no lockfile ' +
    'INSTALLS the `dependencies` its own package.json declares (npm, transitives included, listed in the ' +
    'install approval). One the author has installed into is used as it is when complete, and otherwise ' +
    'refused, naming what is missing — tell the user, do not install into it yourself. A manifest using ' +
    'workspace:/catalog:/link:/file: ranges is left alone — those mean something already resolves it, which ' +
    'is true of any plugin inside this repo.\n' +
    '  • HTTP/github fetches ONE package\'s files, then offers to INSTALL the `dependencies` its ' +
    'package.json declares into its cache directory (npm, transitives included, listed in the approval). ' +
    'Its relative, root-relative and absolute-URL imports are all fetched on demand, so a third-party ' +
    'dependency written as a URL ("https://esm.sh/ms@2.1.3") works too. A BARE import it does not declare ' +
    'means the host\'s own copy, so it must already be present. A URL import is fetched at exactly that URL, ' +
    'and a fetched plugin\'s own file is never imported by its URL (import it by its package name). ' +
    'A dependency it declares but nothing satisfies is reported ' +
    'at boot; an import that resolves nowhere fails naming both the specifier and the file that imported ' +
    'it, and is a genuine unmet dependency — install it, add it to `plugins:` if it is itself a matbot ' +
    'plugin, or express it as a URL. Do not retry name variations. ESM only on this route.\n\n' +
    'What `add` RECORDS in matbot.yaml is the canonical package **name** whenever that name resolves to ' +
    'the same place — so adding "./plugins/foo" configures "@scope/foo", the form that also works in an ' +
    'installed deployment. A path is kept only when nothing else resolves it. Pass whatever specifier you ' +
    'have; the tool normalises.\n\n' +
    'For remove/reload, prefer the plugin\'s canonical package.json **name** (the stable identity shown ' +
    'as `name` by `list`) — the exact matbot.yaml entry also works, but the resolved `specifier` shown ' +
    'under `loaded` may be a file: URL and is NOT the handle. A plugin name is unique, so addressing by ' +
    'name is unambiguous; `add` refuses a second plugin with a name already installed. To run another ' +
    'version of an installed npm plugin, the user installs it with their package manager and you `reload` it.\n\n' +
    'Every refusal of `add` comes before anything is asked or changed, and says what to do instead — follow ' +
    'it; do not retry other spellings of the same specifier.\n\n' +
    '`remove` deletes what a github/http plugin has in the .plugins cache (its source and the dependencies ' +
    'installed into it). What `add` changed in the PROJECT — an npm package it installed, or the node_modules ' +
    'and lockfile it created in a local plugin — is offered back, and only that: a package the project already ' +
    'declared, or one installed before matbot recorded installs, is left alone, with the command to remove it.',
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action: {
        type:        'string',
        enum:        ['list', 'add', 'remove', 'reload', 'discover_local', 'store-key'],
        description: 'list: show configured plugins. add: install and register a plugin. remove: deregister, delete a github/http plugin\'s cached copy, and offer back what add installed into the project. reload: unload and re-import (picks up code changes without restarting; for a remote plugin re-downloads the latest upstream source by default — see refresh). discover_local: scan plugins and the .plugins cache for installable plugins (each result reports its source). store-key: supply a secret (e.g. an API key) that a plugin or provider reported missing — you provide only the key name; the value is entered out-of-band. Leaving that value blank removes the named key instead.',
      },
      refresh: {
        type:        'boolean',
        description: 'reload only. Default true: re-download a remote (github/http) plugin\'s latest upstream source, evicting its .plugins cache. Set false to re-run against the cached copy (reset state, or work offline). No effect on local/npm plugins.',
      },
      specifier: {
        type:        'string',
        description: 'For remove/reload: the plugin\'s canonical package.json name (preferred — the `name` from `list`), ' +
                     'or its exact matbot.yaml entry. For add: a load specifier taking exactly one of three routes — ' +
                     'local (a path, or a bare name a local package declares — preferred over the registry), npm (a ' +
                     'package name nothing local claims, or an explicit "npm:<name>" — never a version, .tgz or git ' +
                     'URL), or http (an HTTP(S) URL or "github:<owner>/<repo>[/<subdir>][#<ref>]"). ' +
                     'An http package.json must resolve and declare a "name". See the tool description for the full grammar.',
      },
      key: {
        type:        'string',
        description: 'Name of the secret to store, e.g. SKILL_RANK_API_KEY (required for store-key). The vault decides which names it can hold — the default one persists to a .env file and takes environment-variable names only (a letter or underscore, then letters, digits or underscores), so prefer that shape; a name it cannot store is rejected with an error stating its rule. The value is prompted for separately and never enters the conversation; entering a blank value removes the key.',
      },
    },
  },
  executor,
};
