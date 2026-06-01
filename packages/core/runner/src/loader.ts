import type { MatbotPlugin, MatbotServices } from './plugin.js';
import { registerPlugin, setupPlugin } from './registry.js';

/**
 * Load plugins from the given specifiers, register them, then run setup().
 *
 * Node: specifiers are npm package names (e.g. "matbot-anthropic") or
 *   file paths relative to the process working directory.
 *
 * Browser: specifiers must be URL paths served from the same origin
 *   (e.g. "/plugins/matbot-anthropic.js" or "./plugins/my-plugin.js").
 *   Bare package names are supported only if an import map is in scope.
 *   A failed import logs a warning and is skipped rather than aborting
 *   startup — the browser has no node_modules to fall back to.
 *
 * Each module must export either:
 *   export const plugin: MatbotPlugin  (named export, preferred)
 *   export default { plugin: MatbotPlugin }  (default export)
 *
 * @param bustCache When true, each specifier is resolved to a file URL and
 *   a unique query parameter is appended before importing. This forces the
 *   JS engine to bypass its module cache and re-evaluate the module from
 *   disk — necessary when reloading a plugin whose code may have changed
 *   since the process started. Has no effect if import.meta.resolve is
 *   unavailable (older engines / import maps); falls back to the original
 *   specifier.
 */
export async function loadPlugins(
  specifiers: readonly string[],
  services:   MatbotServices,
  bustCache = false,
): Promise<MatbotPlugin[]> {
  const importSpecs = bustCache ? specifiers.map(toFreshUrl) : specifiers;

  // Imports run in parallel; registration remains sequential to preserve order.
  const results = await Promise.allSettled(
    importSpecs.map(spec => import(/* @vite-ignore */ spec) as Promise<Record<string, unknown>>),
  );

  const loaded: MatbotPlugin[] = [];

  for (let i = 0; i < specifiers.length; i++) {
    const spec   = specifiers[i]!;
    const result = results[i]!;

    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      if (typeof window !== 'undefined') {
        // Browser: warn and skip — browser environments have no node_modules fallback.
        console.warn(`[matbot] Could not load plugin "${spec}" (browser: use a URL path or configure an import map): ${reason}`);
        continue;
      }
      // Node.js: throw so callers (including the plugin tool) see the actual error.
      console.error(`[matbot] Failed to load plugin "${spec}":`, result.reason);
      throw new Error(`Could not load plugin "${spec}": ${reason}`);
    }

    const mod    = result.value;
    const plugin = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;

    if (plugin === undefined || typeof plugin !== 'object' || !('name' in plugin)) {
      throw new Error(
        `Plugin module "${spec}" does not export a \`plugin\` object. ` +
        `Expected: export const plugin: MatbotPlugin`,
      );
    }

    registerPlugin(plugin, spec);
    await setupPlugin(plugin, services);
    loaded.push(plugin);
  }

  return loaded;
}

/** Append a unique version stamp to force a fresh module evaluation. */
function toFreshUrl(spec: string): string {
  try {
    return `${import.meta.resolve(spec)}?v=${Date.now()}`;
  } catch {
    // import.meta.resolve unavailable or spec not yet resolvable — caller will
    // get the cached module or an import error, same as without busting.
    return spec;
  }
}
