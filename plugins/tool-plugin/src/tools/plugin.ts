import type { Tool, ToolEvent, ToolContext, MatbotPlugin, FormField, Runtime, PluginSource } from '@matatbread/matbot-plugin-api';
import { CONFIRM_YES, CONFIRM_NO, isIncompatibleRuntimeError, isNotAPluginError } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins, getRegisteredTools, getRegisteredFrontendPlugins,
         getRegisteredServiceKeys, getHookPlugins, getSystemContextPlugins,
         getSpecifierForPlugin, getPluginNameForSpecifier } from '@matatbread/matbot-core';
import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import { spawn }                             from 'node:child_process';
import { pathToFileURL, fileURLToPath }       from 'node:url';
import { createRequire }                     from 'node:module';
import path                                  from 'node:path';
import process                               from 'node:process';
import { classifySpecifier, fetchRemoteManifest } from '../remote-cache.js';

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
  if (text.includes(`- ${specifier}`)) return;

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

// Privileged actions (install/remove/first-time load) gate on an out-of-band yes/no. Use a
// structured `confirm` field so rich frontends render real buttons and the affirmative is the
// canonical CONFIRM_YES token — never a parse of the rendered (and potentially localised) label.
async function confirmAction(ctx: ToolContext, label: string): Promise<boolean> {
  const field: FormField = { name: 'confirm', label, type: 'confirm', default: CONFIRM_NO };
  const answer = await ctx.prompt(field);
  return answer.trim().toLowerCase() === CONFIRM_YES;
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

interface DiscoveredPlugin {
  specifier: string;
  name:      string;
  description: string;
  // `type` categorises the origin; `uri` is the concrete source location as a scheme-qualified URI —
  // `file://…` on disk for a local plugin, the `https://…` it was fetched from for a cached one.
  source:    { type: PluginSource; uri: string };
  matbotRuntime?: Runtime[];
}

// Inspect one candidate directory: it is a plugin only if its entry module actually exports a
// `plugin` object — the same contract the loader enforces. The package.json plugin-api dependency is
// only a cheap pre-filter (a library may import the API for its *types*, e.g. `Store<T>`, yet export
// no plugin); making the import load-bearing is what stops such a library from being offered here and
// then failing at install. Returns the discovery entry (with the caller-supplied specifier + source),
// or null.
async function inspectPluginDir(sub: string, specifier: string, source: { type: PluginSource; uri: string }): Promise<DiscoveredPlugin | null> {
  let pkg: { name?: string; description?: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; exports?: unknown; matbotRuntime?: unknown };
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
    ...(runtimes !== undefined ? { matbotRuntime: runtimes } : {}),
  };
}

// TODO: This is a convenience shim for end users in monorepo setups and is
// intentionally narrow. It should eventually be replaced with a proper
// discovery interface — registry lookup, repo scanning, or a plugin marketplace.
//
// Two roots are scanned: the monorepo's `plugins` (source: local) and, if present, the
// `.plugins/` remote-plugin cache (source: github for raw.githubusercontent.com, else cdn) — so a
// previously-fetched remote plugin is rediscoverable and re-installable by its original URL.
async function discoverLocalPlugins(projectDir: string): Promise<DiscoveredPlugin[]> {
  const results: DiscoveredPlugin[] = [];

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
async function scanCacheDir(dotPlugins: string, results: DiscoveredPlugin[]): Promise<void> {
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
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
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
  return [...text.matchAll(/^\s+module:\s+(\S+)/gm)].map(m => m[1] ?? '').filter(Boolean);
}

async function detectPackageManager(dir: string): Promise<string> {
  for (const [pm, lockfile] of [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lockb']] as const) {
    try { await access(path.join(dir, lockfile)); return pm; } catch { /* not present */ }
  }
  return 'npm';
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.on('close', code => {
      if (code === 0) resolve(chunks.join(''));
      else reject(new Error(`${cmd} exited with code ${String(code)}\n${chunks.join('')}`));
    });
  });
}

// The dependency names recorded in the project package.json — used to discover what a pnpm/npm
// install of a tarball/git URL actually added (a URL is not a loadable specifier on restart, but
// the installed package name is). dependencies + optionalDependencies cover what `add` writes.
async function readDependencyNames(projectDir: string): Promise<Set<string>> {
  try {
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
    };
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

async function addedDependencyName(projectDir: string, before: Set<string>): Promise<string | undefined> {
  const after = [...await readDependencyNames(projectDir)].filter(n => !before.has(n));
  return after.length === 1 ? after[0] : undefined;
}

// Turn a raw package-manager failure into an actionable message: name the intent and translate the
// two signatures users actually hit (workspace-only source packages; registry 404s) instead of
// dumping the exit code and stderr alone.
function describeInstallFailure(specifier: string, pm: string, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  let hint = '';
  if (/workspace:|catalog:/i.test(raw)) {
    hint = ' This looks like a workspace-internal source package (it uses the workspace:/catalog: protocol) ' +
           'and cannot be installed standalone — install the published package, or point at its raw source via a URL / github: specifier.';
  } else if (/\b404\b|not found|No matching version/i.test(raw)) {
    hint = ' The package or version was not found in the configured registry (check the name, or the registry in your .npmrc).';
  }
  return `Could not install "${specifier}" with ${pm}:${hint}\n${raw}`;
}

/** If `e` is a module-resolution failure, the bare package specifier it couldn't find — else undefined.
 *  A raw github/URL fetch copies one plugin's own files, not its dependency graph, so a plugin with a
 *  runtime dependency on another package fails here with the package unresolved. We surface the package
 *  name so the caller can give one readable instruction instead of an opaque ERR_MODULE_NOT_FOUND that
 *  sends the model hunting for name variations. */
function missingPackageOf(e: unknown): string | undefined {
  if (!(e instanceof Error) || (e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') return undefined;
  const m = /Cannot find (?:package|module) '([^']+)'/.exec(e.message);
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
  if (Object.keys(p.storage ?? {}).length || p.storageBackend !== undefined
      || serviceKeys.includes('StorageBackend'))                                  t.push('storage');
  if (getRegisteredFrontendPlugins().has(p.name))                                 t.push('frontend');
  if (getHookPlugins().has(p.name))                                               t.push('hooks');
  if (getSystemContextPlugins().has(p.name))                                      t.push('system-context');

  // Any other runtime-registered service (custom cognitive subsystems, domain backends).
  // 'KnowledgeIndex' and 'StorageBackend' are already surfaced as dedicated types above.
  t.push(...serviceKeys);

  if (!t.length) t.push('extension');
  return [...new Set(t)];
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

const executor = {
  async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
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
        ...(p.manifest?.description ? { description: p.manifest.description } : {}),
        ...(p.matbotRuntime !== undefined ? { matbotRuntime: p.matbotRuntime } : {}),
      }));

      yield {
        type:  'result',
        value: {
          loaded,
          configured,
          ...(toolsByPlugin.has(undefined) ? { builtinTools: toolsByPlugin.get(undefined) } : {}),
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
          configuredVia: pluginEntries.has(p.specifier) ? 'plugins'
                       : providerModules.has(p.specifier) ? 'providers'
                       : null,
        })),
      };
      return;
    }

    // ── store-key ──────────────────────────────────────────────────────────────
    // A plugin or provider that needs a secret raises MissingSecretError naming the
    // key; call this to supply it. The value is requested out-of-band via ctx.prompt
    // so it never enters the conversation transcript, then stored in the vault.
    if (action === 'store-key') {
      const { key } = input as { action: 'store-key'; key: string };
      if (!key || !key.trim()) {
        yield { type: 'error', message: 'store-key requires a "key" name.' };
        return;
      }
      const value = await ctx.prompt(`Enter the value for secret "${key.trim()}" (not added to the conversation):`, '');
      if (!value.trim()) {
        yield { type: 'result', value: { message: `No value entered; "${key.trim()}" was not stored.` } };
        return;
      }
      // writeSecret, not createSecret: this answers a MissingSecretError naming an exact key,
      // so the value must land under that name verbatim — no reference/dedup canonicalisation.
      await ctx.vault.writeSecret(key.trim(), value.trim());
      yield { type: 'result', value: { message: `Secret "${key.trim()}" stored in the vault.` } };
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

      // Pre-fetch verification for remote (raw-source) plugins: confirm the package.json declares
      // matbotRuntime including "node" BEFORE downloading or executing any code, so a stray URL
      // cannot be installed. (npm / tarball / git installs are verified after install by the
      // loader's runtime gate + the post-import shape check.)
      let description: string | undefined;
      let remoteName: string | undefined;
      if (classified.kind === 'remote') {
        try {
          const manifest = await fetchRemoteManifest(specifier);
          const rt = manifest.runtimes;
          if (rt === undefined) {
            yield { type: 'error', message:
              `Refusing to install "${specifier}": its package.json has no "matbotRuntime" field, ` +
              `so it cannot be verified as a matbot plugin.` };
            return;
          }
          if (!rt.includes('node')) {
            yield { type: 'error', message:
              `Refusing to install "${specifier}": it declares matbotRuntime [${rt.join(', ')}], which excludes the "node" host.` };
            return;
          }
          const d = manifest.pkg['description'];
          if (typeof d === 'string') description = d;
          if (typeof manifest.pkg['name'] === 'string') remoteName = manifest.pkg['name'];
        } catch (e) {
          yield { type: 'error', message: `Could not install "${specifier}": ${e instanceof Error ? e.message : String(e)}.` };
          return;
        }
      } else {
        description = await pkgDescriptionFromSpecifier(specifier, projectDir);
      }

      // confirmAction rather than a `confirmed` input parameter: plugin installation is a
      // privileged operation. Breaking the LLM's execution chain and requiring an
      // out-of-band human response prevents prompt injection or a malicious plugin
      // from auto-installing further plugins by simply passing confirmed:true.
      const confirmed = await confirmAction(
        ctx,
        `Install plugin **"${specifier}"**?${description !== undefined ? `\n_${description}_` : ''}`,
      );
      if (!confirmed) {
        yield { type: 'result', value: { message: 'Cancelled.' } };
        return;
      }

      // The specifier written to matbot.yaml is usually the one given, but a tarball/git URL is not
      // a loadable specifier on restart — record the installed package name instead.
      let configSpecifier = specifier;

      if (classified.kind === 'npm' || classified.kind === 'pnpm-url') {
        const pm = await detectPackageManager(projectDir);
        yield { type: 'stdout', chunk: `Installing "${specifier}" with ${pm}...\n` };
        const before = await readDependencyNames(projectDir);
        try {
          const out = await runCommand(pm, ['add', specifier], projectDir);
          if (out) yield { type: 'stdout', chunk: out };
        } catch (e) {
          yield { type: 'error', message: describeInstallFailure(specifier, pm, e) };
          return;
        }
        if (classified.kind === 'pnpm-url') {
          const installedName = await addedDependencyName(projectDir, before);
          if (installedName !== undefined) configSpecifier = installedName;
        }
      }

      // Duplicate-name guard: a plugin's canonical package.json `name` is its identity (and the handle
      // remove/reload address it by), and the registry forbids two loaded plugins sharing one. Reject a
      // collision *before* writing config — otherwise the load below fails (the registry throw is
      // swallowed by loadPlugins) and leaves a dangling matbot.yaml entry. Almost always the same
      // package added by two specifiers: a config error, not something to silently double-install.
      const pluginName = remoteName ?? await nameFromSpecifier(configSpecifier, projectDir);
      if (pluginName !== undefined) {
        const clash = getRegisteredPlugins().find(p => p.name === pluginName);
        if (clash !== undefined) {
          yield { type: 'error', message:
            `A plugin named "${pluginName}" is already installed (from "${clash.specifier}"). ` +
            `Remove it first, or — if this is the same package via a different specifier — drop one. ` +
            `Nothing was added to ${path.basename(configPath)}.` };
          return;
        }
      }

      await addPlugin(configPath, configSpecifier);

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
          await removePlugin(configPath, configSpecifier);
          yield { type: 'error', message: e.message };
          return;
        }
        // Definitive, not retryable: state the conclusion ("not a matbot plugin") rather than echoing
        // the loader's `reason`, which reads as a code-fix instruction ("Expected: export const plugin")
        // an LLM may try to act on by editing the library's source.
        if (isNotAPluginError(e)) {
          await removePlugin(configPath, configSpecifier);
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
        const missing = classified.kind === 'remote' ? missingPackageOf(e) : undefined;
        if (missing !== undefined) {
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
      if (!await confirmAction(ctx, `Remove plugin **"${entry}"**?`)) {
        yield { type: 'result', value: { message: 'Cancelled.' } };
        return;
      }

      const removed = await removePlugin(configPath, entry);
      if (!removed) {
        yield { type: 'error', message: `Failed to remove "${entry}" from ${path.basename(configPath)}.` };
        return;
      }

      // Capture the canonical package name before deactivation drops it from the registry: it gates
      // the uninstall offer below and is the correct handle for `pnpm remove` (the config entry may
      // be a path or URL). Falls back to a disk walk for a configured-but-unloaded plugin.
      const pkgName = getPluginNameForSpecifier(entry) ?? await nameFromSpecifier(entry, projectDir);

      yield { type: 'stdout', chunk: `Deactivating "${entry}"...\n` };
      try {
        await ctx.unloadPlugin(entry);
      } catch (e) {
        yield { type: 'stderr', chunk: `Deactivation failed: ${String(e)}\n` };
      }

      // Only offer to uninstall when the package manager actually installed it — i.e. its name is a
      // recorded dependency. Local plugins are referenced in place and cached remote (http/github)
      // plugins live under .plugins/; neither was `pnpm add`-ed, so `pnpm remove` is a no-op at best.
      // Mirrors the add path, which only shells out for npm / tarball-or-git specifiers.
      if (pkgName !== undefined && (await readDependencyNames(projectDir)).has(pkgName)
          && await confirmAction(ctx, `Also uninstall the npm package **"${pkgName}"**?`)) {
        const pm = await detectPackageManager(projectDir);
        try {
          const out = await runCommand(pm, ['remove', pkgName], projectDir);
          if (out) yield { type: 'stdout', chunk: out };
        } catch (e) {
          yield { type: 'stderr', chunk: `Uninstall failed: ${String(e)}\n` };
        }
      }

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
      if (!wasLoaded && !await confirmAction(ctx, `Plugin **"${entry}"** is not currently loaded — load it now?`)) {
        yield { type: 'result', value: { message: 'Cancelled.' } };
        return;
      }

      // Default refresh=true: for a remote (github/http) plugin, reload means "pick up the latest
      // upstream source" — the cross-source analog of how a local reload always reflects on-disk edits.
      // Pass refresh:false to re-run setup() against the cached copy (e.g. to reset state, or offline).
      const { refresh = true } = input as { refresh?: boolean };
      const reloaded = await ctx.loadPlugin(entry, refresh);
      const result = await reloaded.installationMessage?.() || `"${entry}" reloaded successfully.`;

      if (result !== null) {
        yield { type: 'result', value: { message: result } };
      }
    }
  },
};

// ── Tool definition ───────────────────────────────────────────────────────────

export const pluginTool: Tool = {
  name:        'plugin',
  description:
    'Manage matbot plugins — the units that contribute tools, providers, storage, hooks, and ' +
    'frontends to the running process. List or discover them, install or remove one, reload one ' +
    'to pick up code changes without restarting, or supply a secret a plugin or provider ' +
    'reported missing.\n\n' +
    'Parameters depend on `action` (TypeScript):\n' +
    '```ts\n' +
    'type PluginAction =\n' +
    "  | { action: 'list' }                            // configured + loaded plugins, with types, tools, and matbotRuntime\n" +
    "  | { action: 'discover_local' }                  // scan plugins + the .plugins cache; each result carries source {type: local|github|cdn, uri} + matbotRuntime\n" +
    "  | { action: 'add';        specifier: string }   // install & activate (specifier = a Specifier, below)\n" +
    "  | { action: 'remove';     specifier: string }   // deactivate & remove (specifier = package name, preferred — or its matbot.yaml entry)\n" +
    "  | { action: 'reload';     specifier: string; refresh?: boolean }   // re-import without restarting (specifier = package name, preferred — or its matbot.yaml entry).\n" +
    "      // refresh (default true) re-downloads a remote (github/http) plugin's latest upstream source; pass false to re-run against the cached copy (reset state / offline). No effect on local/npm plugins.\n" +
    "  | { action: 'store-key';  key: string };        // store a secret a plugin/provider needs; value entered out-of-band\n" +
    '```\n\n' +
    'A `specifier` (for add/remove/reload) is EXACTLY ONE of these forms — pass a concrete string, ' +
    'not a fuzzy name (run `discover_local` first to find the exact specifier). If the user gives you a ' +
    'specifier, pass it through VERBATIM — never reformat it (especially a github: one):\n' +
    '```ts\n' +
    'type Specifier =\n' +
    '  // npm registry — published packages; resolves via your .npmrc (npmjs, verdaccio, or private)\n' +
    '  | "<name>" | "@<scope>/<name>"            // e.g. "@matatbread/matbot-persist-ki-bge"\n' +
    '  | "<name>@<version|tag|range>"            // e.g. "foo@1.2.3", "@scope/foo@^0.1", "foo@latest"\n' +
    '  // local filesystem — resolved against the project dir; a package.json MUST exist at/above it.\n' +
    '  //   The leading "./" is optional: a bare path is local IFF it exists, else it is read as npm.\n' +
    '  | "./<dir>" | "../<dir>" | "/<abs-dir>" | "file:///<abs-dir>" | "<dir>/<subdir>"\n' +
    '  // HTTP(S) — raw source fetched & cached into .plugins/; OR a .tgz tarball (installed via your\n' +
    '  //   package manager). Raw source MUST resolve a package.json: the URL is one, OR points at a\n' +
    '  //   directory containing one, OR is a code entry with a package.json as its DIRECT SIBLING.\n' +
    '  | "https://<host>/<path>/" | "https://<host>/<path>/package.json"\n' +
    '  | "https://<host>/<path>/<entry>.ts" | "https://<host>/<path>/<pkg>.tgz"\n' +
    '  // GitHub — RAW source fetched & cached. Use this for matbot source plugins (incl. a repo subdir).\n' +
    '  //   The "#<ref>" (branch/tag/commit) comes LAST, after any "/<subdir>". The "#path:" and git+ forms\n' +
    '  //   install via the package manager instead and work ONLY for fully-packaged (published) packages,\n' +
    '  //   NOT raw workspace source — do not use them for a repo subdir.\n' +
    '  | "github:<owner>/<repo>" | "github:<owner>/<repo>#<ref>"\n' +
    '  | "github:<owner>/<repo>/<subdir>" | "github:<owner>/<repo>/<subdir>#<ref>"\n' +
    '  | "github:<owner>/<repo>#path:/<subdir>" | "git+https://<host>/<owner>/<repo>.git";\n' +
    '```\n' +
    'Raw-source (HTTP/github) installs are packages: a package.json must resolve (the URL itself, a ' +
    'directory containing one, or — for a code-entry URL — its direct sibling), it must declare a "name", ' +
    'and its `matbotRuntime` must include "node"; the install is refused otherwise. ' +
    'Cached code lives read-only under `.plugins/`.\n\n' +
    'DEPENDENCY RESOLUTION BY SOURCE — decisive when a plugin depends on OTHER packages:\n' +
    '  • npm names and .tgz/git URLs install through the package manager, which resolves the FULL ' +
    'dependency tree. Use these for a plugin that depends on other packages.\n' +
    '  • A local path resolves dependencies only if they already exist in the surrounding node_modules ' +
    '(true in a workspace checkout, where everything is installed).\n' +
    '  • RAW source (HTTP/github) fetches ONLY that one plugin\'s own files — it does NOT install a ' +
    'dependency graph. A raw-source plugin that imports another package needs that package provided ' +
    'separately (install it too, or just install the plugin from npm). So PREFER npm for any plugin ' +
    'with dependencies; reserve raw github/HTTP for self-contained plugins or testing a single ' +
    'plugin\'s source. If a raw-source install fails with a missing package, that package is a genuine ' +
    'unmet dependency — install it (from npm), do not retry name variations.\n\n' +
    'For remove/reload, prefer the plugin\'s canonical package.json **name** (the stable identity shown ' +
    'as `name` by `list`) — the exact matbot.yaml entry also works, but the resolved `specifier` shown ' +
    'under `loaded` may be a file: URL and is NOT the handle. A plugin name is unique, so addressing by ' +
    'name is unambiguous; `add` refuses a second plugin with a name already installed.',
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action: {
        type:        'string',
        enum:        ['list', 'add', 'remove', 'reload', 'discover_local', 'store-key'],
        description: 'list: show configured plugins. add: install and register a plugin. remove: deregister and optionally uninstall. reload: unload and re-import (picks up code changes without restarting; for a remote plugin re-downloads the latest upstream source by default — see refresh). discover_local: scan plugins and the .plugins cache for installable plugins (each result reports its source). store-key: supply a secret (e.g. an API key) that a plugin or provider reported missing — you provide only the key name; the value is entered out-of-band.',
      },
      refresh: {
        type:        'boolean',
        description: 'reload only. Default true: re-download a remote (github/http) plugin\'s latest upstream source, evicting its .plugins cache. Set false to re-run against the cached copy (reset state, or work offline). No effect on local/npm plugins.',
      },
      specifier: {
        type:        'string',
        description: 'For remove/reload: the plugin\'s canonical package.json name (preferred — the `name` from `list`), ' +
                     'or its exact matbot.yaml entry. For add: a load specifier — exactly one of: an npm name ' +
                     '("@scope/name", optionally "@version"); a local path ("./dir", "/abs", "file://…", or a bare existing ' +
                     'path); an HTTP(S) URL to raw source (a package.json, a directory containing one, or a code entry with a ' +
                     'sibling package.json) or a .tgz; or a github: / git+ specifier. A raw-source package.json must declare a ' +
                     '"name". See the tool description for the full grammar.',
      },
      key: {
        type:        'string',
        description: 'Name of the secret to store, e.g. SKILL_RANK_API_KEY (required for store-key). The value is prompted for separately and never enters the conversation.',
      },
    },
  },
  executor,
};
