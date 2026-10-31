import { readPluginMeta, type PluginLoadRequest } from '@matatbread/matbot-host-node';
import { readFile }                 from 'node:fs/promises';
import { createRequire }            from 'node:module';
import { pathToFileURL }            from 'node:url';
import path                         from 'node:path';
import { classifySpecifier, materializeRemote, remoteDependencyNotes,
         type MaterializedRemote } from './plugins/remote-cache.js';

/**
 * Given a package exports field (or any nested value), return the first
 * string entry point, preferring "import" > "default" > first value.
 */
function resolveExportsEntry(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  // Subpath map: { ".": ... } → unwrap the "." entry
  if ('.' in obj) return resolveExportsEntry(obj['.']);
  // Condition map: prefer import > default > first
  for (const key of ['import', 'default', ...Object.keys(obj)]) {
    if (key in obj) return resolveExportsEntry(obj[key]);
  }
  return undefined;
}

// Resolve npm specifiers against the CLI's own install as well as the config dir. The bundled
// provider adapters are dependencies of the CLI, not of an arbitrary config dir, so a source
// checkout never symlinks them into `<configDir>/node_modules` — only the CLI's own require reaches
// them (the same anchor discoverProviders uses). The first-run wizard stores the bare package name
// (portable once matbot is installed), so without this anchor no turn could load it in a checkout.
const appRequire = createRequire(import.meta.url);

/** Resolve `spec` through `req`, returning the resolved path or undefined when it isn't installed. */
function tryResolve(req: ReturnType<typeof createRequire>, spec: string): string | undefined {
  try { return req.resolve(spec); } catch { return undefined; }
}

/**
 * Resolve config/human plugin specifiers into fully-formed load requests for the platform-neutral
 * loader. Each request keeps the original `spec` (recorded as `plugin.specifier`, so it matches the
 * matbot.yaml entry the user added) alongside the `importSpec` (a file: URL the loader actually
 * imports) and the `name`/`runtimes` read from the resolved package.json. Per the classifier:
 *  - local  → resolve package.json exports["."] so matbot.yaml can reference the package folder
 *             rather than a deep src/ path;
 *  - remote → fetch the module graph into `.plugins/` (idempotent; a restart loads from cache, but
 *             `forceRefresh` from a reload evicts the subtree first to re-download changed source) and
 *             point at the cached entry — bare imports then resolve up to the host's node_modules;
 *  - npm / tarball / git → resolved through the project's module graph (pnpm installs them); a bare
 *             name passes through if not yet on disk so loadPlugins can emit the warning.
 *
 * This is the single funnel for both startup and runtime (`plugin add` / hot-load) resolution.
 */
export async function resolvePluginSpecifiers(specifiers: readonly string[], configDir: string, forceRefresh = false): Promise<PluginLoadRequest[]> {
  const req = createRequire(path.join(configDir, '_'));
  const dotPlugins = path.join(configDir, '.plugins');
  const results: PluginLoadRequest[] = [];
  // Deferred to after the loop: a remote plugin's dependency may be another remote plugin configured
  // LATER, whose files (and name link) do not exist while this one is being fetched.
  const materialized: { spec: string; m: MaterializedRemote }[] = [];

  for (const spec of specifiers) {
    const classified = await classifySpecifier(spec, configDir);
    let importSpec: string;

    if (classified.kind === 'http') {
      try {
        const m = await materializeRemote(spec, dotPlugins, configDir, forceRefresh);
        importSpec = pathToFileURL(m.entry).href;
        materialized.push({ spec, m });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.warn(`[matbot] Could not fetch remote plugin "${spec}": ${reason}`);
        // Unresolved: loadPlugins reports the failure, but importing an http URL fails on the scheme
        // and says nothing about the fetch — so hand it the reason we already have.
        results.push({ spec, importSpec: spec, notes: [`could not be fetched: ${reason}`] });
        continue;
      }
    } else if (classified.kind === 'local' || classified.kind === 'missing-path') {
      const absDir = classified.kind === 'local' ? classified.dir : classified.resolved;
      importSpec = pathToFileURL(absDir).href;
      try {
        const pkg  = JSON.parse(await readFile(path.join(absDir, 'package.json'), 'utf8')) as Record<string, unknown>;
        const main = resolveExportsEntry(pkg['exports']);
        if (typeof main === 'string') importSpec = pathToFileURL(path.resolve(absDir, main)).href;
      } catch { /* no package.json or unparseable — import the directory */ }
    } else {
      // npm / pnpm-url: installed in node_modules under the package name (the stored specifier).
      // Prefer the config dir (a package the user installed in their own project); fall back to the
      // CLI's own install so bundled adapters referenced by bare name still resolve in a source checkout.
      const entry = tryResolve(req, spec) ?? tryResolve(appRequire, spec);
      if (entry === undefined) {
        results.push({ spec, importSpec: spec });  // not on disk — let loadPlugins emit the warning
        continue;
      }
      importSpec = pathToFileURL(entry).href;
    }

    const meta = await readPluginMeta(importSpec, configDir);
    results.push({
      spec,
      importSpec,
      ...(meta.name     !== undefined ? { name:     meta.name }     : {}),
      ...(meta.version  !== undefined ? { version:  meta.version }  : {}),
      ...(meta.runtimes !== undefined ? { runtimes: meta.runtimes } : {}),
    });
  }

  // Every remote is now on disk, so an unsatisfied dependency really is unsatisfied. Warned here
  // because the plugin may well load anyway (an unused declaration, an import the regex over-collected);
  // carried as `notes` so that IF it does fail, the recorded failure says why rather than naming a file.
  for (const { spec, m } of materialized) {
    const notes = await remoteDependencyNotes(m);
    for (const note of notes) console.warn(`[matbot] Plugin "${spec}" ${note}`);
    if (notes.length === 0) continue;
    const entry = results.find(r => r.spec === spec);
    if (entry !== undefined) entry.notes = notes;
  }

  return results;
}

// Whether an adapter's canonical package name is resolvable at load time — the same two-anchor
// resolution the loader uses (config dir, then the CLI's own install for a bundled adapter). Only
// the host can answer this, so the provider tool takes it as a predicate: it prefers the package
// name (location-independent) whenever it resolves, falling back to a path for a local-only adapter
// that has no resolvable name. Pure string resolution — independent of whether the adapter, which
// may load lazily on first use, is registered yet.
export function packageNameResolves(configDir: string): (name: string) => boolean {
  const configRequire = createRequire(path.join(configDir, '_'));
  return name => tryResolve(configRequire, name) !== undefined || tryResolve(appRequire, name) !== undefined;
}
