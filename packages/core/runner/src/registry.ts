import type { Tool, ToolRegistry, Hook, HookPoint, HookContext, PromptFn, FormField } from './types.js';
import type {
  MatbotPlugin, MatbotServices,
  ProviderAdapterFactory, StoreFactory, FrontendFactory,
} from './plugin.js';
import { PLUGIN_API_VERSION } from './plugin.js';
import { HookRegistry } from './hooks.js';

// ── Internal state ────────────────────────────────────────────────────────────

// Mutable arrays/maps held in a single object to make _resetRegistry() simple.
const state = {
  plugins:         [] as MatbotPlugin[],
  providers:       new Map<string, ProviderAdapterFactory>(),
  storage:         new Map<string, StoreFactory>(),
  toolRegistry:    undefined as ToolRegistry | undefined,
  frontend:         undefined as FrontendFactory | undefined,
  frontendPlugins:  new Set<string>(),
  serviceKeys:     new Map<string, string[]>(),  // pluginName → MatbotServices keys it registered
  hookPlugins:        new Set<string>(),         // plugins that registered at least one hook
  systemContextPlugins: new Set<string>(),       // plugins that registered a system-context contributor
  specifierToName: new Map<string, string>(),    // resolved specifier → plugin name
  overwriteAllTools: undefined as boolean | undefined,  // persisted "overwrite on collision, this install" choice, loaded lazily
};

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
  services:      MatbotServices,
  toolName:      string,
  existingOwner: string | undefined,
  incomingOwner: string,
  prompt:        PromptFn | undefined,
): Promise<boolean> {
  if (state.overwriteAllTools === undefined) {
    state.overwriteAllTools = (await services.settings(CORE_SETTINGS_NS).get<boolean>(OVERWRITE_TOOLS_KEY)) ?? false;
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
    await services.settings(CORE_SETTINGS_NS).set(OVERWRITE_TOOLS_KEY, true);
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

export function registerPlugin(plugin: MatbotPlugin, specifier?: string): void {
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

  if (plugin.frontend !== undefined && state.frontend !== undefined) {
    const owner = state.plugins.find(p => p.frontend !== undefined)?.name ?? '?';
    throw new Error(
      `A frontend is already registered by "${owner}". ` +
      `Only one frontend plugin may be active at a time.`,
    );
  }

  state.plugins.push(plugin);

  if (plugin.provider !== undefined) {
    state.providers.set(plugin.name, plugin.provider);
  }
  for (const [type, factory] of Object.entries(plugin.storage ?? {})) {
    state.storage.set(type, factory);
  }
  if (plugin.frontend !== undefined) {
    state.frontend = plugin.frontend;
  }
  if (plugin.frontend !== undefined || plugin.isFrontend === true) {
    state.frontendPlugins.add(plugin.name);
  }
  if (specifier !== undefined) {
    state.specifierToName.set(specifier, plugin.name);
  }
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

export function getRegisteredFrontendPlugins(): ReadonlySet<string> {
  return state.frontendPlugins;
}

/** MatbotServices keys a plugin registered at runtime via services.register() (e.g. 'knowledge'). */
export function getRegisteredServiceKeys(pluginName: string): readonly string[] {
  return state.serviceKeys.get(pluginName) ?? [];
}

/** Plugins that registered at least one hook in setup(). */
export function getHookPlugins(): ReadonlySet<string> {
  return state.hookPlugins;
}

/** Plugins that registered a system-context contributor in setup(). */
export function getSystemContextPlugins(): ReadonlySet<string> {
  return state.systemContextPlugins;
}

/** Resolve a loaded plugin's name from the specifier used to load it. */
export function getPluginNameForSpecifier(specifier: string): string | undefined {
  return state.specifierToName.get(specifier);
}

/** Reverse of getPluginNameForSpecifier — finds the specifier used to load the named plugin. */
export function getSpecifierForPlugin(pluginName: string): string | undefined {
  for (const [spec, name] of state.specifierToName) {
    if (name === pluginName) return spec;
  }
  return undefined;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Run setup() for a single plugin. Called by loadPlugins immediately after registration.
 *
 * `prompt`, when supplied by the host, makes tool-name collisions interactive: registering a
 * tool whose name a *different* plugin already owns asks the user whether to overwrite. Absent
 * (non-interactive host), collisions overwrite silently — the historical default.
 */
export async function setupPlugin(plugin: MatbotPlugin, services: MatbotServices, prompt?: PromptFn): Promise<void> {
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

  const scopedServices: MatbotServices = {
    ...services,
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
        services.hooks.register({ ...hook, pluginName: plugin.name });
      },
      removeByPlugin: (name: string)                      => services.hooks.removeByPlugin(name),
      run:            (point: HookPoint, ctx: HookContext) => services.hooks.run(point, ctx),
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
  };
  for (const tool of plugin.tools ?? []) {
    await registerTool(tool);
  }
  await plugin.setup?.(scopedServices);
}

/** Tear down and fully unload a single plugin, removing all its registered contributions. */
export async function unloadPlugin(pluginName: string, services: MatbotServices): Promise<void> {
  console.warn(`[matbot] Unloading plugin "${pluginName}"`);
  const idx = state.plugins.findIndex(p => p.name === pluginName);
  if (idx === -1) return;

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
  if (state.frontendPlugins.size === 0) {
    state.frontend = undefined;
  }

  for (const [spec, name] of state.specifierToName) {
    if (name === pluginName) state.specifierToName.delete(spec);
  }

  state.plugins.splice(idx, 1);
  return Promise.race([
    plugin.teardown?.(),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`Teardown timeout for plugin ${pluginName}`)), 10000))
  ]);
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

