import type { Tool, ToolRegistry, Hook, HookPoint, HookContext } from './types.js';
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
  serviceKeys:     new Map<string, string[]>(),  // pluginName → ServiceMap keys it registered
  specifierToName: new Map<string, string>(),    // resolved specifier → plugin name
};

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

  for (const type of Object.keys(plugin.providers ?? {})) {
    if (state.providers.has(type)) {
      const owner = state.plugins.find(p => p.providers?.[type] !== undefined)?.name ?? '?';
      throw new Error(
        `Provider type "${type}" is already registered by "${owner}". ` +
        `"${plugin.name}" cannot register it again.`,
      );
    }
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

  for (const [type, factory] of Object.entries(plugin.providers ?? {})) {
    state.providers.set(type, factory);
  }
  for (const [type, factory] of Object.entries(plugin.storage ?? {})) {
    state.storage.set(type, factory);
  }
  if (plugin.frontend !== undefined) {
    state.frontend = plugin.frontend;
  }
  if (specifier !== undefined) {
    state.specifierToName.set(specifier, plugin.name);
  }
}

// ── Resolution ────────────────────────────────────────────────────────────────

export function resolveProviderFactory(type: string): ProviderAdapterFactory {
  const factory = state.providers.get(type);
  if (factory === undefined) {
    const available = [...state.providers.keys()].join(', ') || 'none';
    throw new Error(
      `No provider registered for type "${type}". ` +
      `Available: ${available}. ` +
      `Install and load a provider plugin (e.g. matbot-anthropic).`,
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

/** Resolve a loaded plugin's name from the specifier used to load it. */
export function getPluginNameForSpecifier(specifier: string): string | undefined {
  return state.specifierToName.get(specifier);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/** Run setup() for a single plugin. Called by loadPlugins immediately after registration. */
export async function setupPlugin(plugin: MatbotPlugin, services: MatbotServices): Promise<void> {
  state.toolRegistry ??= services.tools;
  const scopedServices: MatbotServices = {
    ...services,
    tools: {
      register(tool: Tool) { services.tools.register({ ...tool, pluginName: plugin.name }); },
      resolve:       (name: string) => services.tools.resolve(name),
      list:          ()             => services.tools.list(),
      removeByPlugin:(name: string) => services.tools.removeByPlugin(name),
    },
    hooks: {
      register(hook: Hook) { services.hooks.register({ ...hook, pluginName: plugin.name }); },
      removeByPlugin: (name: string)                      => services.hooks.removeByPlugin(name),
      run:            (point: HookPoint, ctx: HookContext) => services.hooks.run(point, ctx),
    } as unknown as HookRegistry,
    systemContext: {
      register(contributor) { services.systemContext.register(contributor, plugin.name); },
      removeByPlugin: (name: string) => services.systemContext.removeByPlugin(name),
      build:          (ctx)          => services.systemContext.build(ctx),
    },
    register(key, svc) {
      const keys = state.serviceKeys.get(plugin.name) ?? [];
      keys.push(key as string);
      state.serviceKeys.set(plugin.name, keys);
      services.register(key, svc);
    },
    registerFrontend() { state.frontendPlugins.add(plugin.name); },
  };
  for (const tool of plugin.tools ?? []) {
    scopedServices.tools.register(tool);
  }
  await plugin.setup?.(scopedServices);
}

/** Tear down and fully unload a single plugin, removing all its registered contributions. */
export async function unloadPlugin(pluginName: string, services: MatbotServices): Promise<void> {
  const idx = state.plugins.findIndex(p => p.name === pluginName);
  if (idx === -1) return;

  const plugin = state.plugins[idx]!;

  try {
    await plugin.teardown?.();
  } catch (e) {
    console.error(`[matbot] teardown error in plugin "${pluginName}":`, e);
  }

  services.tools.removeByPlugin(pluginName);
  services.hooks.removeByPlugin(pluginName);
  services.systemContext.removeByPlugin(pluginName);

  for (const key of state.serviceKeys.get(pluginName) ?? []) {
    services.unregisterService?.(key);
  }
  state.serviceKeys.delete(pluginName);

  for (const type of Object.keys(plugin.providers ?? {})) state.providers.delete(type);
  for (const type of Object.keys(plugin.storage   ?? {})) state.storage.delete(type);

  state.frontendPlugins.delete(pluginName);
  if (state.frontendPlugins.size === 0) {
    state.frontend = undefined;
  }

  for (const [spec, name] of state.specifierToName) {
    if (name === pluginName) state.specifierToName.delete(spec);
  }

  state.plugins.splice(idx, 1);
  console.warn(`[matbot] Unloaded plugin "${pluginName}"`);
}

/** Run each plugin's teardown() in reverse-registration order. Errors are logged, not thrown. */
export async function teardownPlugins(): Promise<void> {
  for (let i = state.plugins.length - 1; i >= 0; i--) {
    const plugin = state.plugins[i]!;
    try {
      await plugin.teardown?.();
    } catch (e) {
      console.error(`[matbot] teardown error in plugin "${plugin.name}":`, e);
    }
  }
}

