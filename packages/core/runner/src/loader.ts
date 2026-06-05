import type { MatbotPlugin, MatbotServices } from './plugin.js';
import type { PromptFn } from './types.js';
import { registerPlugin, setupPlugin } from './registry.js';

/**
 * Query-param marker appended to a plugin entry URL when `bustCache` is set.
 *
 * Core only *marks* the entry; it does not propagate. Interpretation is the job
 * of an optional node-side module-customization hook (see apps/cli/ts-hooks.js),
 * which reads this marker off `context.parentURL` and re-stamps the plugin's
 * first-party imports so the whole subtree re-evaluates — "fresh all the way
 * down". Where no such hook is installed (browser builds; node without the hook)
 * the marker is an inert query string: only the entry module re-evaluates, and
 * a browser frontend reloads the whole realm instead.
 *
 * The name is namespaced so it cannot collide with a query a plugin URL might
 * legitimately carry. Keep it in sync with the hook.
 */
const FRESH_PARAM = 'mbfresh';

// Monotonic tie-breaker: two reloads inside the same millisecond would otherwise
// produce the same stamp and re-hit the cache.
let freshSeq = 0;

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
 * @param bustCache When true, each specifier is resolved to a file URL and a
 *   unique `${FRESH_PARAM}` query stamp is appended before importing. This forces
 *   the JS engine to bypass its module cache and re-evaluate the entry from disk.
 *   With the companion node resolve hook installed (apps/cli/ts-hooks.js) the
 *   stamp propagates to the plugin's first-party imports too, so the entire
 *   subtree re-evaluates — necessary when reloading a plugin whose code, or whose
 *   own modules' code, changed since startup. Has no effect if import.meta.resolve
 *   is unavailable; falls back to the original specifier (and logs a warning).
 * @param prompt Optional host prompt used by setup() to resolve tool-name collisions
 *   interactively. Omitted by non-interactive hosts, in which case collisions overwrite
 *   silently (the historical default).
 */
export async function loadPlugins(
  specifiers: readonly string[],
  services:   MatbotServices,
  bustCache = false,
  prompt?:    PromptFn,
): Promise<MatbotPlugin[]> {
  if (bustCache) {
    console.debug(
      `[matbot] cache-bust requested for ${specifiers.length} plugin(s); the entry is re-evaluated, ` +
      `and its first-party imports too IF the node resolve hook is installed (else only the entry).`,
    );
  }
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

    try {
      registerPlugin(plugin, spec);
      await setupPlugin(plugin, services, prompt);
      loaded.push(plugin);
    } catch (err) {
      console.error(`[matbot] Ignoring plugin "${plugin.name}" from "${spec}" due to an error:`, err instanceof Error ? err.message : err);
    }
  }

  return loaded;
}

/**
 * Stamp a plugin entry URL with a unique `${FRESH_PARAM}` value to force a fresh
 * evaluation (and, with the node resolve hook, a fresh subtree — see FRESH_PARAM).
 *
 * Diagnostics: cache-busting silently degrades in two ways that are
 * indistinguishable from "it worked" at the call site, so both are logged here.
 *   1. import.meta.resolve throws (e.g. a cwd-relative spec that does not resolve
 *      relative to *this* module's URL) — we fall back to the bare spec, which
 *      re-imports the *cached* module. No busting happens at all.
 *   2. Resolution succeeds but no resolve hook is installed: only the entry is
 *      re-evaluated, while everything it statically imports stays cached. We can
 *      detect (1) here; (2) is noted at the call site.
 */
function toFreshUrl(spec: string): string {
  try {
    const url = new URL(import.meta.resolve(spec));
    url.searchParams.set(FRESH_PARAM, `${Date.now()}.${++freshSeq}`);
    const fresh = url.href;
    console.debug(`[matbot] cache-bust: "${spec}" -> ${fresh}`);
    return fresh;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[matbot] cache-bust fallback: import.meta.resolve("${spec}") failed (${reason}); ` +
      `re-importing the CACHED module — changes on disk will NOT be picked up. ` +
      `(Specifiers must be resolvable relative to ${import.meta.url} or be bare package names.)`,
    );
    return spec;
  }
}
