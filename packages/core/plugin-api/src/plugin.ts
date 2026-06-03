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

// ── Service registry ──────────────────────────────────────────────────────────

/**
 * Open interface extended by plugin type packages via module augmentation.
 * Each entry maps a package name (the canonical contract identifier) to the
 * service interface it defines.
 *
 * Example (in @matatbread/matbot-memory-types):
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface ServiceMap {
 *       '@matatbread/matbot-memory-types': MemoryManager;
 *     }
 *   }
 */
export interface ServiceMap {}

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

  /** Look up a service registered by a plugin. Key is the plugin's types package name. */
  get<K extends keyof ServiceMap>(key: K): ServiceMap[K] | undefined;

  /** Register a service implementation. Called by a plugin's setup() to advertise itself. */
  register<K extends keyof ServiceMap>(key: K, service: ServiceMap[K]): void;

  /** Remove a service entry previously registered by a plugin. */
  unregisterService?(key: string): void;

  /**
   * Replace the active storage backend at runtime. All Store and FileStore references
   * previously vended by createStore / services.sessions / services.files remain valid —
   * they are forwarding proxies that will transparently route to the new backend after
   * this call returns. The old backend is closed if it implements close().
   */
  replaceStorageBackend?(next: StorageBackend): Promise<void>;

  /** Declare that this plugin provides a frontend. The runtime records the plugin name implicitly. */
  registerFrontend?(): void;

  readonly providers:      ReadonlyMap<string, ProviderConfig>;
  readonly sessions?:      Store<Session>;
  readonly storageBackend?: StorageBackend | undefined;
  readonly files?:      FileStore;
  readonly vault:          Vault;
  readonly hooks:          HookRegistry;
  readonly tools:          ToolRegistry;
  readonly systemContext:  SystemContextRegistry;
  /** Default working directory for tool execution. Plugins that create servers should forward this to tool contexts. */
  readonly workdir?:    string;
  /** Absolute path to the loaded config file. Plugins that create servers should forward this to tool contexts. */
  readonly configPath?: string;

  readonly knowledge: KnowledgeIndex;
  replaceKnowledgeBackend(impl: KnowledgeIndex): void;
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
  /** Process env var names required by this plugin (e.g. 'OPENAI_API_KEY') */
  credentials?: readonly string[];
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
  readonly name:       string;
  readonly apiVersion: string;
  readonly manifest?:  PluginManifest;
  readonly provider?:  ProviderAdapterFactory;
  readonly storage?:   Record<string, StoreFactory>;
  readonly tools?:     readonly Tool[];
  readonly frontend?:  FrontendFactory;
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
