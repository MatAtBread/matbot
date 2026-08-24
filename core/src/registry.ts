import type { Tool, ToolRegistry, Hook, PromptFn, FormField, FrontendInfo, ProviderAdapter, ProviderConfig, FailedPlugin } from './types.js';
import { RegistryChangeKind } from '@matatbread/matbot-plugin-api';
import { scopedNotifier } from '@matatbread/matbot-plugin-api/host';
import type {
  MatbotPlugin, MatbotMachine, MatbotRuntime, Mounted,
  ProviderAdapterFactory, StoreFactory,
} from './plugin.js';
import { PLUGIN_API_VERSION, unifyServices } from './plugin.js';
import { makePluginSettings } from './settings.js';
import type { SettingsDoc } from './settings.js';

// ── Internal state ────────────────────────────────────────────────────────────

// `FailedPlugin` now lives in plugin-api: `plugin list` reports it, so it is part of that tool's
// contract, and the contract has to be declarable from a package this one can reach.

// Mutable arrays/maps held in a single object to make _resetRegistry() simple.
const state = {
  plugins:         [] as MatbotPlugin[],
  providers:       new Map<string, ProviderAdapterFactory>(),
  storage:         new Map<string, StoreFactory>(),
  toolRegistry:    undefined as ToolRegistry | undefined,
  frontendPlugins:  new Map<string, FrontendInfo>(),  // pluginName → info, written by services.registerFrontend()
  serviceKeys:     new Map<string, string[]>(),  // pluginName → MatbotMachine keys it registered
  hookPlugins:        new Set<string>(),         // plugins that registered at least one hook
  systemContextPlugins: new Set<string>(),       // plugins that registered a system-context contributor
  lifecycles:      new Map<string, AbortController>(),  // pluginName → "this plugin is loaded" signal, aborted on unload
  failedPlugins:   [] as FailedPlugin[],         // plugins the loader skipped, keyed by specifier (last failure wins)
  overwriteAllTools: undefined as boolean | undefined,  // persisted "overwrite on collision, this install" choice, loaded lazily
};

// Plugin load/unload is announced on the Notifier as a `RegistryChange` with `registry: 'plugins'`, for
// consumers that key off plugin presence (e.g. the web plugins panel refreshing live when a backend
// restores a plugin set out of band). It was a module-level broadcaster of its own, which is the same
// primitive the bus already is. `loaded` is announced by the loader — the only caller of
// registerPlugin, and the one place holding the machine this registry deliberately doesn't.
export function announcePluginLoaded(services: MatbotMachine, name: string): void {
  services.Notifier.notify({ kind: RegistryChangeKind, source: 'plugins', registry: 'plugins', name, operation: 'added' });
}

// Settings namespace + key under which the user's "overwrite all colliding tools" choice
// is persisted for the installation. The namespace doubles as a Store document id, so it must
// satisfy the storage id charset (/^[\w-]+$/) — hence underscores, not '@matbot/core'. The
// dunder marks it reserved (internal), so it won't collide with a real plugin's settings.
const CORE_SETTINGS_NS    = '__matbot_core__';
const OVERWRITE_TOOLS_KEY = 'overwriteToolsOnCollision';

/**
 * Decide whether an incoming tool registration may overwrite an existing tool of the
 * same name owned by a different plugin. Returns true to overwrite, false to keep the
 * existing one and drop the incoming registration.
 *
 * Resolution order: a persisted "overwrite all (this install)" choice short-circuits to
 * true; otherwise the user is prompted [n / Y / all] with Y (overwrite) as the default.
 * 'all' persists the choice. With no prompt available (non-interactive host) we overwrite —
 * the default — preserving matbot's historical last-registration-wins behaviour.
 */
async function resolveToolCollision(
  services:      MatbotMachine,
  toolName:      string,
  existingOwner: string | undefined,
  incomingOwner: string,
  prompt:        PromptFn | undefined,
): Promise<boolean> {
  const coreSettings = makePluginSettings(services.createStore<SettingsDoc>('settings'), CORE_SETTINGS_NS);
  if (state.overwriteAllTools === undefined) {
    state.overwriteAllTools = (await coreSettings.get<boolean>(OVERWRITE_TOOLS_KEY)) ?? false;
  }
  if (state.overwriteAllTools) return true;

  const owner = existingOwner !== undefined ? `"${existingOwner}"` : 'a built-in';
  const label = `Tool \`"${toolName}"\` is already registered by **${owner}**. Overwrite it with the one from **"${incomingOwner}"**?`;

  if (prompt === undefined) {
    console.warn(`[matbot] ${label} — non-interactive, overwriting (default).`);
    return true;
  }

  const field: FormField = {
    name:    'overwrite',
    label,
    type:    'select',
    options: ['Keep existing', 'Overwrite', 'Always overwrite'],
    default: 'Overwrite',
  };
  const answer = (await prompt(field)).trim().toLowerCase();
  if (answer.startsWith('a')) {  // "Always overwrite" — persist for the installation
    state.overwriteAllTools = true;
    await coreSettings.set(OVERWRITE_TOOLS_KEY, true);
    return true;
  }
  return !answer.startsWith('k');  // "Keep existing" → false; "Overwrite"/default → true
}

// ── Version check ─────────────────────────────────────────────────────────────

function checkApiVersion(plugin: MatbotPlugin): void {
  const [rMajor = '0', rMinor = '0'] = PLUGIN_API_VERSION.split('.');
  const [pMajor = '0', pMinor = '0'] = plugin.apiVersion.split('.');

  if (pMajor !== rMajor) {
    throw new Error(
      `Plugin "${plugin.name}" requires API ${plugin.apiVersion} (major ${pMajor}) ` +
      `but runtime provides ${PLUGIN_API_VERSION}. ` +
      `Update the plugin or the runtime.`,
    );
  }
  if (Number(pMinor) > Number(rMinor)) {
    console.warn(
      `[matbot] Plugin "${plugin.name}" targets API ${plugin.apiVersion} ` +
      `but runtime is ${PLUGIN_API_VERSION}. Some features may not be available.`,
    );
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerPlugin(plugin: MatbotPlugin): void {
  checkApiVersion(plugin);

  if (state.plugins.some(p => p.name === plugin.name)) {
    throw new Error(`Plugin "${plugin.name}" is already registered.`);
  }

  if (plugin.provider !== undefined && state.providers.has(plugin.name)) {
    throw new Error(`Provider "${plugin.name}" is already registered.`);
  }

  for (const type of Object.keys(plugin.storage ?? {})) {
    if (state.storage.has(type)) {
      const owner = state.plugins.find(p => p.storage?.[type] !== undefined)?.name ?? '?';
      throw new Error(
        `Storage type "${type}" is already registered by "${owner}". ` +
        `"${plugin.name}" cannot register it again.`,
      );
    }
  }

  state.plugins.push(plugin);

  if (plugin.provider !== undefined) {
    state.providers.set(plugin.name, plugin.provider);
  }
  for (const [type, factory] of Object.entries(plugin.storage ?? {})) {
    state.storage.set(type, factory);
  }
}

// ── Resolution ────────────────────────────────────────────────────────────────

export function tryResolveProviderFactory(module: string): ProviderAdapterFactory | undefined {
  return state.providers.get(module);
}

/**
 * Config → live adapter, loading the adapter module on demand. The fast path resolves an already
 * registered factory. When the factory is absent (the common case now the boot pre-scan is disabled, or
 * a provider profile a storage backend replayed from its medium ahead of its adapter module) the module
 * is force-loaded and the loaded plugin's own factory is used — sidestepping the canonical-name keying the
 * factory registry uses. Returns `null` (and warns, never throws) if the module can't be loaded or carries
 * no adapter, so one unusable profile can't abort a turn.
 */
export async function instantiateProvider(services: MatbotRuntime, config: ProviderConfig): Promise<ProviderAdapter | null> {
  // Resolve the factory tolerantly. `config.module` may be the canonical plugin name or any specifier that
  // identifies the plugin — the factory registry is keyed by plugin name, so when a raw specifier misses we
  // map it to the loaded plugin's name (a sibling profile sharing this adapter module may have loaded it
  // already). The stored profile is NEVER rewritten: it stays exactly as the source wrote it (yaml path,
  // npm name, or a storage-backend manifest entry), so `provider list` reports the source truth rather than
  // a mix of specifiers and package names that depends on which profiles happen to have been used.
  // The specifier→name scan only matches the *exact* string a profile was loaded with, so two profiles
  // naming one adapter by different specifiers (a yaml path and the package name) miss each other; the
  // host resolver closes that gap by deriving the canonical name the registry is actually keyed by —
  // without it the second specifier force-loads and dies on "already registered".
  const name = tryResolveProviderFactory(config.module) !== undefined
    ? config.module
    : getPluginNameForSpecifier(config.module)
      ?? await services.resolver?.identify(config.module).catch(() => undefined);
  if (name !== undefined) {
    const factory = tryResolveProviderFactory(name);
    if (factory !== undefined) return factory(config);
  }

  // Not loaded yet — force-load the adapter module on demand (a runtime-contributed profile, or a disabled
  // pre-scan). Warn and return null rather than throw, so one unusable profile can't abort a turn. The next
  // resolution hits the fast path above via specifier→name, so this loads at most once per adapter module.
  try {
    const plugin = await services.loadPlugin(config.module);
    if (plugin.provider === undefined) {
      console.warn(`[matbot] provider "${config.name}": module "${config.module}" loaded but registered no adapter.`);
      return null;
    }
    return plugin.provider(config);
  } catch (err) {
    console.warn(`[matbot] provider "${config.name}": could not load adapter module "${config.module}":`, err);
    return null;
  }
}

export function getRegisteredTools(): readonly Tool[] {
  return state.toolRegistry?.list() ?? [];
}

export function getRegisteredPlugins(): readonly MatbotPlugin[] {
  return state.plugins;
}

/**
 * Plugins the loader skipped rather than loaded — the graceful-but-not-silent record. One entry per
 * specifier (a repeated failure overwrites the prior one; a subsequent successful load clears it via
 * clearFailedPlugin). Surfaced by the `plugin` tool's `list` and the web plugins panel.
 */
export function getFailedPlugins(): readonly FailedPlugin[] {
  return state.failedPlugins;
}

/** Record (or replace, by specifier) a plugin the loader skipped. Called from loader.ts skip points. */
export function recordFailedPlugin(entry: FailedPlugin): void {
  const idx = state.failedPlugins.findIndex(f => f.specifier === entry.specifier);
  if (idx === -1) state.failedPlugins.push(entry);
  else            state.failedPlugins[idx] = entry;
}

/** Drop any recorded failure for a specifier — a fixed + reloaded plugin drops off the failed list. */
export function clearFailedPlugin(specifier: string): void {
  const idx = state.failedPlugins.findIndex(f => f.specifier === specifier);
  if (idx !== -1) state.failedPlugins.splice(idx, 1);
}

export function getRegisteredFrontendPlugins(): ReadonlyMap<string, FrontendInfo> {
  return state.frontendPlugins;
}

/** MatbotMachine keys a plugin registered at runtime via services.register() (e.g. 'KnowledgeIndex'). */
export function getRegisteredServiceKeys(pluginName: string): readonly string[] {
  return state.serviceKeys.get(pluginName) ?? [];
}

/**
 * Attribute a service key to a plugin out of band. The host uses this for a backend it opened at boot
 * *before* the registry knew the plugin's name — a storageBackend manifest pre-scan bypasses the scoped
 * register() that would normally record the key. Recording it makes the boot-opened backend unload-equal
 * to a runtime register(): unloadPlugin() then calls unregister() for it, reverting to the host base.
 */
export function recordServiceKey(pluginName: string, key: string): void {
  const keys = state.serviceKeys.get(pluginName) ?? [];
  if (!keys.includes(key)) keys.push(key);
  state.serviceKeys.set(pluginName, keys);
}

/** Plugins that registered at least one hook in setup(). */
export function getHookPlugins(): ReadonlySet<string> {
  return state.hookPlugins;
}

/** Plugins that registered a system-context contributor in setup(). */
export function getSystemContextPlugins(): ReadonlySet<string> {
  return state.systemContextPlugins;
}

/** Resolve a loaded plugin's name from the specifier used to load it. Each plugin carries its own
 *  specifier, so this is a scan of the plugin list — no side-map to keep in sync. */
export function getPluginNameForSpecifier(specifier: string): string | undefined {
  return state.plugins.find(p => p.specifier === specifier)?.name;
}

/** Reverse of getPluginNameForSpecifier — finds the specifier used to load the named plugin. */
export function getSpecifierForPlugin(pluginName: string): string | undefined {
  return state.plugins.find(p => p.name === pluginName)?.specifier;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Run setup() for a single plugin. Called by loadPlugins immediately after registration.
 *
 * `prompt`, when supplied by the host, makes tool-name collisions interactive: registering a
 * tool whose name a *different* plugin already owns asks the user whether to overwrite. Absent
 * (non-interactive host), collisions overwrite silently — the historical default.
 */
export async function setupPlugin(plugin: MatbotPlugin, services: MatbotMachine, prompt?: PromptFn): Promise<void> {
  state.toolRegistry ??= services.tools;

  // This plugin's load extent. The mount table's only cleanup path is an aborted signal, and the
  // option is optional — so an author who omits it left an interest that outlives the unload and
  // keeps firing into a torn-down closure (once per reload generation). Ownership is the host's to
  // know, not the author's to remember: every scoped observe() is bound to this signal, so `signal`
  // in the options is a narrowing convenience ("stop earlier than my unload"), never load-bearing.
  const previous = state.lifecycles.get(plugin.name);
  previous?.abort();                                  // a reload that skipped unloadPlugin
  const lifecycle = new AbortController();
  state.lifecycles.set(plugin.name, lifecycle);

  // Single choke point for every plugin tool registration (static `plugin.tools` and in-setup
  // `services.tools.register`). Stamps ownership and resolves name collisions. The no-collision
  // path runs synchronously (an async fn yields nothing before its first await), so fire-and-forget
  // callers that don't await still get the tool registered in the same tick — which is the whole
  // reason `ToolRegistry.register` returns `void`, and every one of its ~34 call sites relies on it.
  //
  // That makes the collision branch the one place with an await and no caller to own its outcome, so
  // it owns its own: a throw from the settings read/write or the prompt (a non-interactive `PromptFn`
  // rejects with PromptCancelledError) would otherwise be an unhandled rejection — process exit under
  // Node's default — reached by the ordinary act of two plugins claiming one tool name. Keep-existing
  // is the safe resolution, so a failure resolves to it. The abort check closes the other end: setup()
  // has already returned by the time a slow collision resolves, so an unload (or a setup() throw and
  // its rollback) can land first, and re-inserting the tool would revive one owned by a gone plugin.
  const registerTool = async (tool: Tool): Promise<void> => {
    const stamped: Tool = { ...tool, pluginName: plugin.name };
    const existing = services.tools.resolve(stamped.name);
    if (existing !== null && existing.pluginName !== plugin.name) {
      const overwrite = await resolveToolCollision(services, stamped.name, existing.pluginName, plugin.name, prompt)
        .catch((e: unknown) => {
          console.error(
            `[matbot] Could not resolve the "${stamped.name}" tool collision for plugin "${plugin.name}" ` +
            `— keeping the existing tool:`, e instanceof Error ? e.message : e,
          );
          return false;
        });
      if (!overwrite) return;
      if (lifecycle.signal.aborted) return;
    }
    services.tools.register(stamped);
  };

  // Plugin-scoped settings: bound to this plugin's identity, built once. A plugin reaches only its
  // own settings — there is no way to name another's.
  const ownSettings = makePluginSettings(services.createStore<SettingsDoc>('settings'), plugin.name);

  // Per-plugin `mounted`: a thin adapter over the host mount table that delivers *this plugin's* scoped
  // machine (and scoped onUnmount) to handlers. The stable `scoped` object reads through the host's
  // re-pointing proxies/registry, so `scoped[key]` is the host's live service by the time a transition
  // fires. Forward-referenced via `scoped`, assigned below; consume() only runs after setup.
  let scoped: MatbotMachine;
  const scopedMounted: Mounted = {
    observe(options, handler) {
      // Forward to the host mount table but deliver *this plugin's* scoped machine — it reads through
      // the same proxies/registry, so scoped[key] is the host's live service. onUnmount is scoped too.
      const forwarded = {
        ...options,
        signal: options.signal !== undefined ? AbortSignal.any([lifecycle.signal, options.signal]) : lifecycle.signal,
        ...(options.onUnmount !== undefined ? { onUnmount: () => options.onUnmount!(scoped) } : {}),
      };
      services.mounted.observe(forwarded, () => handler(scoped as never));
    },
  };

  scoped = unifyServices({
    ...services,
    mounted: scopedMounted,
    settings: () => ownSettings,
    self: {
      name:      plugin.name,
      specifier: plugin.specifier,
      ...(plugin.source !== undefined ? { source: plugin.source } : {}),
    },
    // Everything this plugin publishes is attributed to it by default — the notification analogue of
    // stamping `pluginName` on its tools. Reads through the host's swap proxy, so a registered
    // distributed Notifier takes effect for a plugin that captured this in setup().
    get Notifier() { return scopedNotifier(services.Notifier, plugin.name); },
    tools: {
      register:      registerTool,
      remove:        (name: string) => services.tools.remove(name),
      resolve:       (name: string) => services.tools.resolve(name),
      list:          ()             => services.tools.list(),
      removeByPlugin:(name: string) => services.tools.removeByPlugin(name),
    },
    hooks: {
      register(hook: Hook) {
        state.hookPlugins.add(plugin.name);
        services.hooks.register({ ...hook, pluginName: plugin.name } as Hook);
      },
      removeByPlugin: (name: string) => services.hooks.removeByPlugin(name),
    },
    systemContext: {
      register(contributor) {
        state.systemContextPlugins.add(plugin.name);
        services.systemContext.register(contributor, plugin.name);
      },
      removeByPlugin: (name: string) => services.systemContext.removeByPlugin(name),
      build:          (ctx)          => services.systemContext.build(ctx),
      parts:          (ctx)          => services.systemContext.parts(ctx),
    },
    async register(key, svc) {
      const keys = state.serviceKeys.get(plugin.name) ?? [];
      keys.push(key as string);
      state.serviceKeys.set(plugin.name, keys);
      await services.register(key, svc);
    },
    registerFrontend(info) {
      state.frontendPlugins.set(plugin.name, info);
    },
  });
  for (const tool of plugin.tools ?? []) {
    await registerTool(tool);
  }
  await plugin.setup?.(scoped);
}

/** Tear down and fully unload a single plugin, removing all its registered contributions. */
export async function unloadPlugin(pluginName: string, services: MatbotMachine): Promise<boolean> {
  console.warn(`[matbot] Unloading plugin "${pluginName}"`);
  const idx = state.plugins.findIndex(p => p.name === pluginName);
  if (idx === -1) return false;

  // Note: all synchronous cleanup (removing tools, hooks, services) is done before any asynchronous teardown() calls, to ensure a consistent state even if teardown() fails or hangs.
  const plugin = state.plugins[idx]!;

  services.tools.removeByPlugin(pluginName);
  services.hooks.removeByPlugin(pluginName);
  services.systemContext.removeByPlugin(pluginName);
  // Drops this plugin's mount interests. Before teardown(), with the other synchronous removals: a
  // mount handler firing between here and teardown would run against half-removed state.
  state.lifecycles.get(pluginName)?.abort();
  state.lifecycles.delete(pluginName);

  for (const key of state.serviceKeys.get(pluginName) ?? []) {
    services.unregister(key);
  }
  state.serviceKeys.delete(pluginName);
  state.hookPlugins.delete(pluginName);
  state.systemContextPlugins.delete(pluginName);

  if (plugin.provider !== undefined) state.providers.delete(plugin.name);
  for (const type of Object.keys(plugin.storage   ?? {})) state.storage.delete(type);

  state.frontendPlugins.delete(pluginName);

  state.plugins.splice(idx, 1);
  services.Notifier.notify({ kind: RegistryChangeKind, source: 'plugins', registry: 'plugins', name: pluginName, operation: 'removed' });
  await Promise.race([
    plugin.teardown?.(),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`Teardown timeout for plugin ${pluginName}`)), 10000))
  ]);
  return true;
}

/** Run each plugin's teardown() in reverse-registration order. Errors are logged, not thrown. */
export async function teardownPlugins(): Promise<void> {
  // Reverse once and keep it: indexing the *unreversed* array to name a result reported the wrong
  // plugin for every failure but the middle one.
  const ordered = [...state.plugins].reverse();
  const results = await Promise.allSettled(ordered.map(plugin => plugin.teardown?.()));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[matbot] teardown error in plugin "${ordered[i]?.name}":`, result.reason);
    }
  });
}

