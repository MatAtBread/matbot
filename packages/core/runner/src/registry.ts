import type { Tool, ToolRegistry, Hook, PromptFn, FormField, FrontendInfo, PluginRegistryEvent } from './types.js';
import { createBroadcaster, subscribable } from '@matatbread/matbot-plugin-api';
import type {
  MatbotPlugin, MatbotMachine,
  ProviderAdapterFactory, StoreFactory,
} from './plugin.js';
import { PLUGIN_API_VERSION, unifyServices } from './plugin.js';
import { HookRegistry } from './hooks.js';
import { makePluginSettings } from './settings.js';
import type { SettingsDoc } from './settings.js';

// ── Internal state ────────────────────────────────────────────────────────────

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
  overwriteAllTools: undefined as boolean | undefined,  // persisted "overwrite on collision, this install" choice, loaded lazily
};

// Read-only observation of plugin load/unload, for consumers that key off plugin presence (e.g. the
// web plugins panel refreshing live when a backend restores a plugin set out of band). Module-level,
// not in `state` — it owns subscribers across the registry's lifetime, not per-plugin data.
const pluginEvents = createBroadcaster<PluginRegistryEvent>();

export function watchPlugins(signal?: AbortSignal): AsyncIterable<PluginRegistryEvent> {
  return pluginEvents.subscribe(signal);
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

  pluginEvents.emit({ type: 'loaded', name: plugin.name });
}

// ── Resolution ────────────────────────────────────────────────────────────────

export function resolveProviderFactory(module: string): ProviderAdapterFactory {
  const factory = state.providers.get(module);
  if (factory === undefined) {
    const available = [...state.providers.keys()].join(', ') || 'none';
    throw new Error(
      `No provider registered for module "${module}". ` +
      `Available: ${available}. ` +
      `Install and load the provider plugin.`,
    );
  }
  return factory;
}

export function getRegisteredTools(): readonly Tool[] {
  return state.toolRegistry?.list() ?? [];
}

export function getRegisteredPlugins(): readonly MatbotPlugin[] {
  return state.plugins;
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

  // Single choke point for every plugin tool registration (static `plugin.tools` and in-setup
  // `services.tools.register`). Stamps ownership and resolves name collisions. The no-collision
  // path runs synchronously (an async fn yields nothing before its first await), so fire-and-forget
  // callers that don't await still get the tool registered in the same tick.
  const registerTool = async (tool: Tool): Promise<void> => {
    const stamped: Tool = { ...tool, pluginName: plugin.name };
    const existing = services.tools.resolve(stamped.name);
    if (existing !== null && existing.pluginName !== plugin.name) {
      const overwrite = await resolveToolCollision(services, stamped.name, existing.pluginName, plugin.name, prompt);
      if (!overwrite) return;
    }
    services.tools.register(stamped);
  };

  // Plugin-scoped settings: bound to this plugin's identity, built once. A plugin reaches only its
  // own settings — there is no way to name another's.
  const ownSettings = makePluginSettings(services.createStore<SettingsDoc>('settings'), plugin.name);

  // Per-plugin `mounted`: re-emits *this plugin's* scoped machine on every host StorageBackend swap (not
  // on subscribe — the initial machine is the setup() call itself; `mounted` is its deferred encore). The
  // element is the stable `scoped` object: it reads through the host's re-pointing proxies, so the
  // same reference already sees the new backend by the time the host announces the swap. Forward-referenced
  // via `scoped`, assigned below; the generator body only runs on subscribe (after setup), by which point
  // it is defined.
  let scoped: MatbotMachine;
  const scopedMounted = subscribable<MatbotMachine>(async function* (signal) {
    for await (const _ of services.mounted.subscribe(signal)) yield scoped;
  });

  scoped = unifyServices({
    ...services,
    mounted: scopedMounted,
    settings: () => ownSettings,
    self: {
      name:      plugin.name,
      specifier: plugin.specifier,
      ...(plugin.source !== undefined ? { source: plugin.source } : {}),
    },
    tools: {
      register:      registerTool,
      remove:        (name: string) => services.tools.remove(name),
      resolve:       (name: string) => services.tools.resolve(name),
      list:          ()             => services.tools.list(),
      removeByPlugin:(name: string) => services.tools.removeByPlugin(name),
      watch:         (signal?: AbortSignal) => services.tools.watch(signal),
    },
    hooks: {
      register(hook: Hook) {
        state.hookPlugins.add(plugin.name);
        services.hooks.register({ ...hook, pluginName: plugin.name } as Hook);
      },
      removeByPlugin: (name: string) => services.hooks.removeByPlugin(name),
    } as unknown as HookRegistry,
    systemContext: {
      register(contributor) {
        state.systemContextPlugins.add(plugin.name);
        services.systemContext.register(contributor, plugin.name);
      },
      removeByPlugin: (name: string) => services.systemContext.removeByPlugin(name),
      build:          (ctx)          => services.systemContext.build(ctx),
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
  pluginEvents.emit({ type: 'unloaded', name: pluginName });
  await Promise.race([
    plugin.teardown?.(),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`Teardown timeout for plugin ${pluginName}`)), 10000))
  ]);
  return true;
}

/** Run each plugin's teardown() in reverse-registration order. Errors are logged, not thrown. */
export async function teardownPlugins(): Promise<void> {
  const results = await Promise.allSettled([...state.plugins].reverse().map(plugin => plugin.teardown?.()));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[matbot] teardown error in plugin "${state.plugins[i]?.name}":`, result.reason);
    }
  });
}

