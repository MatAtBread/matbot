import type { MatbotPlugin, MatbotPluginSpec, MatbotServices, PluginSource, Runtime } from './plugin.js';
import type { PromptFn } from './types.js';
import { IncompatibleRuntimeError } from '@matatbread/matbot-plugin-api';
import { registerPlugin, setupPlugin, unloadPlugin } from './registry.js';

/**
 * The runtime this process is executing in. Detected the same way the rejected-import branch below
 * already distinguishes platforms (`typeof window`). Used only for the declarative pre-import gate;
 * an absent `matbotRuntime` declaration bypasses the gate entirely.
 */
const CURRENT_RUNTIME: Runtime = typeof window !== 'undefined' ? 'browser' : 'node';

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
 * A specifier is normally a string that is both imported and recorded as the plugin's
 * `specifier`. The object form decouples those concerns for a host that has already done its
 * own resolution:
 *   - `spec` — recorded as the plugin's `specifier` (the human/config-level identity).
 *   - `importSpec` — the URL actually imported, when it differs from `spec`. The browser
 *     fetches a remote plugin, type-strips it, and imports the resulting ephemeral `blob:`
 *     URL while recording the original source URL as `spec`; node imports a resolved
 *     `file://` path while recording the original `matbot.yaml` entry. (With `importSpec`
 *     set, `bustCache` does not apply — the caller owns that URL, and a `blob:` cannot carry
 *     a `${FRESH_PARAM}` stamp.) Defaults to `spec`.
 *   - `name` — the canonical plugin name, when the host has already derived it (e.g. by
 *     reading the resolved package.json). Bypasses `resolver.identify(spec)` — necessary
 *     because `spec` (a remote URL, a versioned npm range) may not itself identify the name.
 *   - `runtimes` — the package.json `matbotRuntime`, when the host has already read it; used
 *     for the pre-import gate in place of `resolver.runtimes(spec)`.
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
 * @param onIncompatibleRuntime What to do when a plugin's `matbotRuntime` excludes this host.
 *   `'skip'` (default, the startup batch) warns and moves on — one mis-targeted plugin in the
 *   config must not abort the process. `'throw'` is for an explicit, single, user-initiated load
 *   (the `plugin`/`provider` tools via `services.loadPlugin`): the user named *this* plugin, so a
 *   silent skip would surface only as a confusing empty-result error downstream — fail loudly with
 *   the reason instead. Both modes share the one gate below; only the mismatch reaction differs.
 */
export async function loadPlugins(
  specifiers: readonly (string | { spec: string; importSpec?: string; name?: string; runtimes?: readonly Runtime[] })[],
  services:   MatbotServices,
  bustCache = false,
  prompt?:    PromptFn,
  onIncompatibleRuntime: 'skip' | 'throw' = 'skip',
): Promise<MatbotPlugin[]> {
  const reqs = specifiers.map(s => (typeof s === 'string' ? { spec: s } : s) as { spec: string; importSpec?: string; name?: string; runtimes?: readonly Runtime[] });
  if (bustCache) {
    console.debug(
      `[matbot] cache-bust requested for ${specifiers.length} plugin(s); the entry is re-evaluated, ` +
      `and its first-party imports too IF the node resolve hook is installed (else only the entry).`,
    );
  }
  // Declarative pre-import gate. A plugin whose package.json `matbotRuntime` lists runtimes that
  // exclude this host is skipped *before* import() — its (possibly platform-specific) top-level
  // code never evaluates here, which is both the quick path and the only safe one for, e.g., a
  // node-only plugin reached from a browser. An *absent* declaration means "don't know": the
  // resolver returns undefined and we import it, falling back to the try-load / rollback path
  // below. Reading the declaration is the host resolver's job (this module stays node-free).
  const declared = await Promise.all(
    reqs.map(({ spec, runtimes }) =>
      runtimes !== undefined                     ? Promise.resolve(runtimes)
      : services.resolver?.runtimes !== undefined ? services.resolver.runtimes(spec)
      :                                             Promise.resolve(undefined),
    ),
  );

  const toLoad: { spec: string; importSpec: string; name?: string; runtimes?: readonly Runtime[] }[] = [];
  for (let i = 0; i < reqs.length; i++) {
    const { spec, importSpec, name } = reqs[i]!;
    const runtimes = declared[i];
    if (runtimes !== undefined && runtimes.length > 0 && !runtimes.includes(CURRENT_RUNTIME)) {
      if (onIncompatibleRuntime === 'throw') {
        throw new IncompatibleRuntimeError(spec, runtimes, CURRENT_RUNTIME);
      }
      console.warn(`[matbot] Skipping plugin "${spec}": declares matbotRuntime [${runtimes.join(', ')}], host runtime is "${CURRENT_RUNTIME}".`);
      continue;
    }
    toLoad.push({
      spec,
      importSpec: importSpec ?? (bustCache ? toFreshUrl(spec) : spec),
      ...(name     !== undefined ? { name }     : {}),
      ...(runtimes !== undefined ? { runtimes } : {}),
    });
  }

  // Imports run in parallel; registration remains sequential to preserve order.
  const results = await Promise.allSettled(
    toLoad.map(({ importSpec }) => import(/* @vite-ignore */ importSpec) as Promise<Record<string, unknown>>),
  );

  const loaded: MatbotPlugin[] = [];

  for (let i = 0; i < toLoad.length; i++) {
    const spec   = toLoad[i]!.spec;
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

    const mod  = result.value;
    const spec_obj = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPluginSpec | undefined;

    // Shape verification: a loaded module is a matbot plugin only if it exports a `plugin` object
    // carrying `apiVersion`, and any lifecycle members it declares are functions. This is the
    // post-import half of the install guard (the pre-import half is the package.json matbotRuntime
    // check) — it is what stops an arbitrary fetched/installed module from being treated as a plugin.
    if (spec_obj === undefined || typeof spec_obj !== 'object') {
      throw new Error(
        `Plugin module "${spec}" does not export a \`plugin\` object — it is not a matbot plugin. ` +
        `Expected: export const plugin: MatbotPluginSpec`,
      );
    }
    if (!('apiVersion' in spec_obj)) {
      throw new Error(
        `Plugin module "${spec}" exports a \`plugin\` object with no \`apiVersion\` — it is not a valid matbot plugin.`,
      );
    }
    const lifecycle = spec_obj as { setup?: unknown; teardown?: unknown; installationMessage?: unknown };
    for (const fn of ['setup', 'teardown', 'installationMessage'] as const) {
      const v = lifecycle[fn];
      if (v !== undefined && typeof v !== 'function') {
        throw new Error(`Plugin module "${spec}" exports \`plugin.${fn}\` that is not a function (got ${typeof v}).`);
      }
    }

    // The single boundary where an author's spec becomes a loaded plugin: identity is stamped here,
    // never declared by the author. The host-injected resolver derives the canonical name; absent a
    // resolver (e.g. a bare host) we fall back to platform-neutral string munging.
    const name     = toLoad[i]!.name ?? (services.resolver !== undefined ? await services.resolver.identify(spec) : defaultIdentify(spec));
    const source   = sourceOf(spec);
    const runtimes = toLoad[i]!.runtimes;
    const plugin: MatbotPlugin = {
      ...spec_obj,
      name,
      specifier: spec,
      ...(source   !== undefined ? { source }                 : {}),
      ...(runtimes !== undefined ? { matbotRuntime: runtimes } : {}),
    };

    // registered gates the rollback: only an attempt that *itself* registered the
    // plugin may unload it. A registerPlugin failure means the name/provider/storage
    // was already owned by a different, healthy plugin — unloading by name there would
    // tear down that innocent bystander.
    let registered = false;
    try {
      registerPlugin(plugin);
      registered = true;
      await setupPlugin(plugin, services, prompt);
      loaded.push(plugin);
    } catch (err) {
      console.error(`[matbot] Ignoring plugin "${plugin.name}" from "${spec}" due to an error:`, err instanceof Error ? err.message : err);
      // Roll back partial registration so a failed load leaves no ghost state. setupPlugin
      // can throw after the plugin is already in the registry with some of its tools / hooks /
      // services / provider / storage wired (a wrong-platform plugin touching a missing
      // primitive mid-setup is the common case). unloadPlugin is the exact inverse of
      // register + setup, so it removes precisely those contributions. We run it defensively:
      // a half-set-up plugin's own teardown() may throw, and a rollback failure must not abort
      // the remaining loads.
      if (registered) {
        try {
          await unloadPlugin(plugin.name, services);
        } catch (cleanupErr) {
          console.error(
            `[matbot] Cleanup after failed load of "${plugin.name}" did not fully complete; some state may linger:`,
            cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
          );
        }
      }
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
/**
 * Classify how a specifier resolves to code, from its shape alone (platform-neutral; no fs).
 * github shorthand is only recognised via the explicit `github:` prefix — a bare `owner/repo`
 * is indistinguishable from a scoped npm package and is treated as npm.
 */
function sourceOf(spec: string): PluginSource | undefined {
  if (/^https?:\/\//.test(spec))                                    return 'cdn';
  if (spec.startsWith('github:'))                                   return 'github';
  if (spec.startsWith('file://') || spec.startsWith('./') ||
      spec.startsWith('../')     || spec.startsWith('/'))           return 'local';
  return 'npm';
}

/**
 * Degraded name derivation used only when no PluginResolver is injected. A bare package name is its
 * own identity; anything path/URL-shaped collapses to its last segment (query and extension
 * stripped). Real hosts inject a resolver that walks package.json (node) or parses the CDN URL
 * (browser); this exists so a resolver-less host still loads rather than crashing.
 */
function defaultIdentify(spec: string): string {
  if (sourceOf(spec) === 'npm') return spec;
  const noQuery = (spec.split('?')[0]) ?? spec;
  const last    = noQuery.replace(/\/+$/, '').split('/').pop() ?? noQuery;
  return last.replace(/\.[^.]+$/, '') || noQuery;
}

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
