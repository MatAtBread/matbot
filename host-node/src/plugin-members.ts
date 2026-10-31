import { readFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { getPluginNameForSpecifier, getRegisteredPlugins, unloadPlugin } from '@matatbread/matbot-core';
import type { HostMembers, MatbotMachine, MatbotPlugin, PromptFn } from '@matatbread/matbot-core';
import { loadPluginsWithDescriptions, readPluginMeta, type PluginLoadRequest } from './plugin-description.js';
import { nodePluginResolver } from './plugin-resolver.js';

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

/** The import URL of a package directory: its `exports["."]` entry, else the directory itself. So config
 *  can name the package folder rather than a deep `src/` path. */
export async function packageEntry(dir: string): Promise<string> {
  try {
    const pkg  = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    const main = resolveExportsEntry(pkg['exports']);
    if (typeof main === 'string') return pathToFileURL(path.resolve(dir, main)).href;
  } catch { /* no package.json or unparseable — import the directory */ }
  return pathToFileURL(dir).href;
}

/** The import URL of an installed package, resolved from each of `fromDirs` in turn; undefined when none
 *  has it on disk. */
export function installedEntry(spec: string, fromDirs: readonly string[]): string | undefined {
  for (const dir of fromDirs) {
    try { return pathToFileURL(createRequire(path.join(dir, '_')).resolve(spec)).href; } catch { /* try the next */ }
  }
  return undefined;
}

/** A load request for `importSpec`, carrying the name, version and runtimes its package.json declares. */
export async function loadRequest(spec: string, importSpec: string, baseDir: string): Promise<PluginLoadRequest> {
  const meta = await readPluginMeta(importSpec, baseDir);
  return {
    spec,
    importSpec,
    ...(meta.name     !== undefined ? { name:     meta.name }     : {}),
    ...(meta.version  !== undefined ? { version:  meta.version }  : {}),
    ...(meta.runtimes !== undefined ? { runtimes: meta.runtimes } : {}),
  };
}

/**
 * Resolve a plugin that is already where Node can import it: a path (relative to `baseDir`), or a package
 * installed where `baseDir` resolves. Nothing is fetched or installed — that is acquisition, which a host
 * opts into with `@matatbread/matbot-host-node/plugins`. A specifier that resolves to nothing passes
 * through, so the loader reports it.
 */
export async function resolveInstalledPlugin(spec: string, baseDir: string): Promise<PluginLoadRequest> {
  const bare = (spec.split('?')[0]) ?? spec;
  if (bare.startsWith('file://') || bare.startsWith('./') || bare.startsWith('../') || path.isAbsolute(bare)) {
    const dir = bare.startsWith('file://') ? fileURLToPath(bare) : path.resolve(baseDir, bare);
    return loadRequest(spec, await packageEntry(dir), baseDir);
  }
  const entry = installedEntry(spec, [baseDir]);
  return entry !== undefined ? loadRequest(spec, entry, baseDir) : { spec, importSpec: spec };
}

/** Unload by the specifier a plugin was loaded with, or by its canonical name. */
export async function unloadNodePlugin(specifier: string, machine: MatbotMachine): Promise<boolean> {
  const name = getPluginNameForSpecifier(specifier)
    ?? (getRegisteredPlugins().some(p => p.name === specifier) ? specifier : undefined);
  if (name === undefined) {
    console.warn(`[matbot] No loaded plugin found for "${specifier}"`);
    return false;
  }
  return unloadPlugin(name, machine);
}

/** Node's own type stripper: blanks types in place, so line numbers survive. */
export const nodeTypeScriptStripper: NonNullable<HostMembers['TypeScriptStripper']> = {
  strip: (source: string) => stripTypeScriptTypes(source),
};

/**
 * The plugin-loading members of a Node host that loads only what is already on disk — a matbot embedded
 * in an application, with a fixed set of plugins and no `plugin` tool. A host that acquires plugins (the
 * CLI) resolves through acquisition instead, and builds its own `loadPlugin` from the same pieces.
 */
export function nodePluginMembers(
  machine: () => MatbotMachine, baseDir: string,
): Pick<HostMembers, 'loadPlugin' | 'unloadPlugin' | 'resolver' | 'TypeScriptStripper'> {
  return {
    async loadPlugin(specifier: string, prompt?: PromptFn): Promise<MatbotPlugin> {
      const request = await resolveInstalledPlugin(specifier, baseDir);
      const plugin  = (await loadPluginsWithDescriptions([request], machine(), baseDir, /* bustCache */ false, prompt, /* onLoadError */ 'throw'))[0];
      if (plugin === undefined) throw new Error(`No plugin loaded for specifier "${specifier}"`);
      return plugin;
    },
    unloadPlugin: (specifier: string) => unloadNodePlugin(specifier, machine()),
    resolver:     nodePluginResolver(baseDir),
    TypeScriptStripper: nodeTypeScriptStripper,
  };
}
