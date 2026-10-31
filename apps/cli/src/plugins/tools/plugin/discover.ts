import type { DiscoveredPlugin, PluginSource, MatbotPlugin, ToolEvent, ToolResultOf } from '@matatbread/matbot-core';
import { readFile, access, readdir }      from 'node:fs/promises';
import { pathToFileURL, fileURLToPath }  from 'node:url';
import path                              from 'node:path';
import { readPluginsList, readProviderModules } from '../../config-entries.js';
import { normalizeRuntimes }             from './identity.js';

export async function* discoverPlugins(configPath: string): AsyncIterable<ToolEvent<ToolResultOf<'plugin'>>> {
  const projectDir = path.dirname(configPath);
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

// Inspect one candidate directory. `matbotRuntime` is what makes a package a plugin, so a package without
// it is passed over before anything is imported — a library's top-level code is not run to find out.
// Then its entry module must actually export a `plugin` object, the same contract the loader enforces.
// Returns the discovery entry (with the caller-supplied specifier + source), or null.
async function inspectPluginDir(sub: string, specifier: string, source: { type: PluginSource; uri: string }): Promise<DiscoveryEntry | null> {
  let pkg: { name?: string; version?: string; description?: string; exports?: unknown; matbotRuntime?: unknown };
  try {
    pkg = JSON.parse(await readFile(path.join(sub, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return null;
  }
  const runtimes = normalizeRuntimes(pkg.matbotRuntime);
  if (runtimes === undefined || runtimes.length === 0) return null;

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
  return {
    specifier,
    name:          pkg.name ?? path.basename(sub),
    description,
    source,
    ...(pkg.version !== undefined ? { version: pkg.version } : {}),
    matbotRuntime: runtimes,
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
