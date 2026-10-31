import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginResolver, Runtime } from '@matatbread/matbot-core';
import { startDir } from './plugin-description.js';

const VALID_RUNTIMES: readonly Runtime[] = ['node', 'browser'];

/** Coerce a raw package.json `matbotRuntime` value into a runtime list, or undefined if absent/malformed. */
function normalizeRuntimes(raw: unknown, pkgName: string): readonly Runtime[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.warn(`[matbot] Ignoring matbotRuntime in "${pkgName}": expected an array of ${VALID_RUNTIMES.join('/')}, got ${typeof raw}.`);
    return undefined;
  }
  const valid = raw.filter((r): r is Runtime => VALID_RUNTIMES.includes(r as Runtime));
  for (const r of raw) {
    if (!VALID_RUNTIMES.includes(r as Runtime)) {
      console.warn(`[matbot] Ignoring unknown matbotRuntime "${String(r)}" in "${pkgName}" (known: ${VALID_RUNTIMES.join(', ')}).`);
    }
  }
  return valid;
}

/**
 * Node host PluginResolver: derives a plugin's canonical name (its package.json `name`) from the
 * specifier it was loaded with. This is the single source of plugin identity on the node host —
 * the loader calls identify() to stamp `MatbotPlugin.name`, so authors no longer hand-declare it.
 *
 * A bare npm name is already the package name and passes through. A path / file: URL is resolved to
 * a start directory and the nearest package.json walked up to; its `name` wins, falling back to the
 * directory's basename if no package.json carries one.
 */
export function nodePluginResolver(baseDir: string): PluginResolver {
  return {
    async identify(specifier: string): Promise<string> {
      const bare = (specifier.split('?')[0]) ?? specifier;
      const isPathLike = bare.startsWith('file://') || bare.startsWith('./') ||
                         bare.startsWith('../')     || path.isAbsolute(bare);
      if (!isPathLike) return specifier; // bare npm name — already the package name

      let dir = startDir(specifier, baseDir);
      if (dir === undefined) return specifier;
      const fallback = path.basename(dir);

      while (true) {
        try {
          const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
          if (pkg.name) return pkg.name;
        } catch { /* no package.json here, keep walking up */ }
        const parent = path.dirname(dir);
        if (parent === dir) return fallback; // filesystem root reached without a named package.json
        dir = parent;
      }
    },

    // Read `version` off the plugin's package.json — the nearest named one, the same boundary
    // identify() uses. Undefined when unreadable (no package.json / no version field).
    async version(specifier: string): Promise<string | undefined> {
      let dir = startDir(specifier, baseDir);
      if (dir === undefined) return undefined;
      while (true) {
        try {
          const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
          if (pkg.name) return pkg.version;
        } catch { /* no package.json here, keep walking up */ }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    },

    // Read `matbotRuntime` off the plugin's package.json — the nearest one with a `name`, the same
    // boundary identify() uses — so a declaration on the plugin (not an enclosing monorepo root) wins.
    // Undefined means "not declared": the loader then imports and falls back to load/rollback.
    async runtimes(specifier: string): Promise<readonly Runtime[] | undefined> {
      let dir = startDir(specifier, baseDir);
      if (dir === undefined) return undefined;
      while (true) {
        try {
          const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string; matbotRuntime?: unknown };
          if (pkg.name) return normalizeRuntimes(pkg.matbotRuntime, pkg.name);
        } catch { /* no package.json here, keep walking up */ }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    },
  };
}
