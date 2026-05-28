import type { Tool } from './types.js';
import type {
  MatbotPlugin, MatbotServices,
  ProviderAdapterFactory, StoreFactory, FrontendFactory,
} from './plugin.js';
import { PLUGIN_API_VERSION } from './plugin.js';

// ── Internal state ────────────────────────────────────────────────────────────

// Mutable arrays/maps held in a single object to make _resetRegistry() simple.
const state = {
  plugins:   [] as MatbotPlugin[],
  providers: new Map<string, ProviderAdapterFactory>(),
  storage:   new Map<string, StoreFactory>(),
  tools:     [] as Tool[],
  frontend:  undefined as FrontendFactory | undefined,
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

export function registerPlugin(plugin: MatbotPlugin): void {
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
  if (plugin.tools) {
    state.tools.push(...plugin.tools);
  }
  if (plugin.frontend !== undefined) {
    state.frontend = plugin.frontend;
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

export function resolveStorageFactory(type: string): StoreFactory {
  const factory = state.storage.get(type);
  if (factory === undefined) {
    const available = [...state.storage.keys()].join(', ') || 'none';
    throw new Error(
      `No storage backend registered for type "${type}". Available: ${available}.`,
    );
  }
  return factory;
}

export function getRegisteredTools(): readonly Tool[] {
  return state.tools;
}

export function getRegisteredPlugins(): readonly MatbotPlugin[] {
  return state.plugins;
}

export function getFrontendFactory(): FrontendFactory | undefined {
  return state.frontend;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/** Run setup() for a single plugin. Called by loadPlugins immediately after registration. */
export async function setupPlugin(plugin: MatbotPlugin, services: MatbotServices): Promise<void> {
  const scopedServices: MatbotServices = {
    ...services,
    tools: {
      register(tool: Tool) { services.tools.register({ ...tool, pluginName: plugin.name }); },
      resolve: (name: string) => services.tools.resolve(name),
      list:    ()             => services.tools.list(),
    },
  };
  for (const tool of plugin.tools ?? []) {
    scopedServices.tools.register(tool);
  }
  await plugin.setup?.(scopedServices);
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

/** Reset all registry state. Intended for tests only. */
export function _resetRegistry(): void {
  state.plugins.length = 0;
  state.providers.clear();
  state.storage.clear();
  state.tools.length = 0;
  state.frontend = undefined;
}
