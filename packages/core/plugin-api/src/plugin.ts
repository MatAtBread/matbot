import type {
  FileStore, Vault, Message, ModelParameters,
  ProviderAdapter, ProviderConfig, Tool, ToolRegistry, FrontendAdapter,
  Store, Session, SystemContextRegistry, KnowledgeIndex,
} from './types.js';
import type { HookRegistry } from './hooks.js';

export const PLUGIN_API_VERSION = '0.1';

// ── Sub-runner types ──────────────────────────────────────────────────────────

export interface CompletionRequest {
  provider:    string;
  messages:    Message[];
  system?:     string;
  parameters?: Partial<ModelParameters>;
  signal?:     AbortSignal;
}

export interface CompletionResponse {
  text:  string;
  usage: { inputTokens: number; outputTokens: number };
}

// ── Plugin settings ───────────────────────────────────────────────────────────

/** Scoped key-value store for a single plugin's runtime settings. */
export interface PluginSettings {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

// ── Services container ────────────────────────────────────────────────────────

export interface MatbotServices {
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /** Returns a namespaced settings store for the given plugin. Keys are isolated per plugin name. */
  settings(pluginName: string): PluginSettings;

  /** Hot-load a plugin by specifier into the running process. Returns the loaded plugin. */
  loadPlugin(specifier: string): Promise<MatbotPlugin>;

  /** Hot-unload a plugin by specifier, removing its tools, hooks, and system context contributions. */
  unloadPlugin(specifier: string): Promise<void>;

  /**
   * Create (or retrieve a cached) typed store for the given namespace.
   * The backing implementation is determined by the runtime (filesystem by default;
   * a storage plugin may substitute a database backend).
   * Namespaces are isolated: 'schedules' and 'settings' never share documents.
   */
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T>;

  /**
   * Register a service under a MatbotServices key. Well-known keys have dedicated behaviour:
   *   'storageBackend' — replaces the active storage backend and re-wires all Store proxies.
   *   'knowledge'      — replaces the active KnowledgeIndex, draining entries from the old one.
   * All other keys store the value in a per-plugin service registry accessible via get().
   *
   * Third-party plugins advertise novel services by augmenting MatbotServices:
   *
   *   declare module '@matatbread/matbot-plugin-api' {
   *     interface MatbotServices { memory?: MemoryManager; }
   *   }
   *
   * Then register and retrieve with full type safety:
   *   await services.register('memory', new MemoryManagerImpl(store));
   *   const mem = services.get('memory'); // MemoryManager | undefined
   */
  register<K extends keyof MatbotServices>(key: K, value: NonNullable<MatbotServices[K]>): Promise<void>;

  /** Look up a service registered under a MatbotServices key via register(). */
  get<K extends keyof MatbotServices>(key: K): MatbotServices[K] | undefined;

  /** @internal Remove a service entry — called by the runtime when the registering plugin is unloaded. */
  unregister(key: string): void;

  readonly providers:       ReadonlyMap<string, ProviderConfig>;
  readonly sessions?:       Store<Session>;
  readonly storageBackend?: StorageBackend | undefined;
  readonly files?:          FileStore;
  readonly vault:           Vault;
  readonly hooks:           HookRegistry;
  readonly tools:           ToolRegistry;
  readonly systemContext:   SystemContextRegistry;
  /** Default working directory for tool execution. Plugins that create servers should forward this to tool contexts. */
  readonly workdir?:        string;
  /** Absolute path to the loaded config file. Plugins that create servers should forward this to tool contexts. */
  readonly configPath?:     string;

  readonly knowledge: KnowledgeIndex;
}

// ── Factory types ─────────────────────────────────────────────────────────────

export type ProviderAdapterFactory = (config: ProviderConfig) => ProviderAdapter;

export type StoreFactory = (
  kind:    string,
  options: Record<string, unknown>,
) => Store<{ id: string; version: string }>;

export type FrontendFactory = (services: MatbotServices) => FrontendAdapter;

// ── Plugin manifest ───────────────────────────────────────────────────────────

export interface PluginManifest {
  /** Human-readable description shown by `matbot install` */
  description?: string;
  /** matbot.yaml extensions.<pluginName> keys this plugin reads */
  config?: readonly string[];
}

// ── Storage backend ───────────────────────────────────────────────────────────

/**
 * A storage backend replaces both the document store factory and the file store.
 * Registered by a plugin's storageBackend.open() before the services object is built.
 */
export interface StorageBackend {
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T>;
  readonly fileStore: FileStore;
  close?(): Promise<void>;
}

// ── Plugin interface ──────────────────────────────────────────────────────────

export interface MatbotPlugin {
  readonly name:        string;
  readonly apiVersion:  string;
  readonly manifest?:   PluginManifest;
  readonly provider?:   ProviderAdapterFactory;
  readonly storage?:    Record<string, StoreFactory>;
  readonly tools?:      readonly Tool[];
  readonly frontend?:   FrontendFactory;
  /** True for plugins that act as frontends but manage their own I/O without a FrontendFactory. */
  readonly isFrontend?: boolean;
  /**
   * When present, the runtime calls open(dotData) before creating the services
   * object and uses the returned backend for all Store and FileStore creation.
   * The plugin must be listed before any plugin whose setup() calls createStore.
   */
  readonly storageBackend?: {
    open(dotData: string): Promise<StorageBackend>;
  };
  setup?(services: MatbotServices): Promise<void>;
  teardown?(): Promise<void>;
  installationMessage?(): Promise<string>;
}
