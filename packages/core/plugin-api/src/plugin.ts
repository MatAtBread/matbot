import type {
  FileStore, Vault, Message, ModelParameters,
  ProviderAdapter, ProviderConfig, Tool, ToolRegistry, FrontendInfo,
  Store, Session, SystemContextRegistry, KnowledgeIndex, PromptFn, SessionRunner,
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

// ── Plugin identity ─────────────────────────────────────────────────────────────

/** How a plugin specifier resolves to code. Loader-established, never author-declared. */
export type PluginSource = 'local' | 'npm' | 'cdn' | 'github';

/** The execution environments a plugin can run in, as declared by `matbotRuntime` in package.json. */
export type Runtime = 'node' | 'browser';

/**
 * Host-provided mapping from a load specifier to a plugin's canonical name.
 *
 * Identity is loader-established, not author-declared: the loader calls identify() at the single
 * boundary where a MatbotPluginSpec becomes a MatbotPlugin. Deriving a name walks package.json
 * (node) or parses a CDN URL (browser), so the implementation is host-specific and injected via
 * MatbotServices rather than living in the platform-neutral core.
 */
export interface PluginResolver {
  identify(specifier: string): Promise<string>;
  /**
   * The runtimes a plugin declares support for via its package.json `matbotRuntime`
   * (e.g. `["node"]`, `["browser"]`, `["node","browser"]`), or `undefined` when the field is
   * absent — meaning "don't know". The loader skips a plugin *before* importing it when this
   * returns a non-empty list that excludes the current runtime; `undefined` falls back to the
   * try-load / catch / rollback path. Reading the declaration is host-specific (walk package.json
   * on node; consult the baked manifest in the browser), so it lives here, not in the core loader.
   */
  runtimes?(specifier: string): Promise<readonly Runtime[] | undefined>;
}

/** A plugin's own loader-established identity, exposed to its setup() via scoped services. */
export interface PluginSelf {
  readonly name:      string;
  readonly specifier: string;
  readonly source?:   PluginSource;
}

// ── Services container ────────────────────────────────────────────────────────

export interface MatbotServices {
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /** The calling plugin's own settings store. Scoped to the plugin — it cannot reach another's. */
  settings(): PluginSettings;

  /**
   * Hot-load a plugin by specifier into the running process. Returns the loaded plugin.
   * `prompt`, when supplied, resolves tool-name collisions interactively during the new
   * plugin's setup(); the runner injects the triggering session's prompt automatically.
   */
  loadPlugin(specifier: string, prompt?: PromptFn): Promise<MatbotPlugin>;

  /**
   * Hot-unload a plugin by specifier, removing its tools, hooks, and system context contributions.
   * Resolves `true` if a plugin was resident and unloaded, `false` if there was nothing to unload.
   */
  unloadPlugin(specifier: string): Promise<boolean>;

  /**
   * Create (or retrieve a cached) typed store for the given namespace.
   * The backing implementation is determined by the runtime (filesystem by default;
   * a storage plugin may substitute a database backend).
   * Namespaces are isolated: 'schedules' and 'settings' never share documents.
   */
  createStore<T extends { id: string; version: string }>(namespace: string): Store<T>;

  /**
   * Register a service under a MatbotServices key (the key is the interface name it carries).
   * Well-known keys have dedicated behaviour:
   *   'StorageBackend' — replaces the active storage backend and re-wires all Store proxies.
   *   'KnowledgeIndex' — replaces the active KnowledgeIndex, draining entries from the old one.
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

  /**
   * Declare the calling plugin as a frontend. Being a frontend is an action taken in setup(),
   * symmetric with register() — not a static manifest flag. A frontend owns its own I/O; matbot
   * only records that it exists. Multiple frontends may be active at once. Auto-unregistered when
   * the plugin is unloaded.
   */
  registerFrontend(info: FrontendInfo): void;

  /** @internal Remove a service entry — called by the runtime when the registering plugin is unloaded. */
  unregister(key: string): void;

  /** Host-injected name deriver, used by the loader to stamp plugin identity. */
  readonly resolver?:       PluginResolver;
  /** The calling plugin's own loader-established identity. Bound per-plugin inside setup(). */
  readonly self?:           PluginSelf;

  readonly providers:       ReadonlyMap<string, ProviderConfig>;
  readonly sessions?:       Store<Session>;
  /** Per-session turn serialiser. Frontends submit and observe through this rather than calling
   *  runSession directly, so concurrent submits queue instead of clobbering the session. */
  readonly run?:            SessionRunner | undefined;
  readonly StorageBackend?: StorageBackend | undefined;
  readonly files?:          FileStore;
  readonly vault:           Vault;
  readonly hooks:           HookRegistry;
  readonly tools:           ToolRegistry;
  readonly systemContext:   SystemContextRegistry;
  /** Default working directory for tool execution. Plugins that create servers should forward this to tool contexts. */
  readonly workdir?:        string;
  /** Absolute path to the loaded config file. Plugins that create servers should forward this to tool contexts. */
  readonly configPath?:     string;

  readonly KnowledgeIndex: KnowledgeIndex;
}

/**
 * Wrap a services object so every registered service is reachable as a member (`services.InterfaceName`),
 * not only via `services.get('InterfaceName')` — one access surface for base members and plugin-registered
 * services alike. A member read of a key the object doesn't carry falls back to its own `get()` (the
 * registry), so the augmentation that declares `InterfaceName?: InterfaceName` is also the access path;
 * the optional `?` is the single call-site signal of "may be absent, null-check it". Assignment throws,
 * directing callers to `register()` (the swap-aware write path). Applied to both the host services object
 * and the per-plugin scoped object, so plugins see the same surface the host does.
 */
export function unifyServices(services: MatbotServices): MatbotServices {
  return new Proxy(services, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      return typeof key === 'string' ? target.get(key as keyof MatbotServices) : undefined;
    },
    has(target, key) {
      if (Reflect.has(target, key)) return true;
      return typeof key === 'string' && target.get(key as keyof MatbotServices) !== undefined;
    },
    set(_target, key) {
      throw new Error(
        `Cannot assign services.${String(key)} directly — use services.register('${String(key)}', impl) to register or replace a service.`,
      );
    },
  });
}

// ── Factory types ─────────────────────────────────────────────────────────────

export type ProviderAdapterFactory = (config: ProviderConfig) => ProviderAdapter;

export type StoreFactory = (
  kind:    string,
  options: Record<string, unknown>,
) => Store<{ id: string; version: string }>;

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

/**
 * What a plugin author writes. No identity — that is loader-established, not the author's to assign.
 * The loader turns a MatbotPluginSpec into a MatbotPlugin by stamping name/specifier/source.
 */
export interface MatbotPluginSpec {
  readonly apiVersion:  string;
  readonly manifest?:   PluginManifest;
  readonly provider?:   ProviderAdapterFactory;
  readonly storage?:    Record<string, StoreFactory>;
  readonly tools?:      readonly Tool[];
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

/**
 * A loaded plugin: the author's spec plus the provenance the loader stamps at load time.
 * Every consumer (registry, tools, UI) sees this type and reads `.name` / `.specifier` off it.
 */
export interface MatbotPlugin extends MatbotPluginSpec {
  readonly name:      string;   // resolver.identify(specifier)
  readonly specifier: string;   // how it was loaded
  readonly source?:   PluginSource;
  // The package.json `matbotRuntime`, captured at load from the same value used for the pre-import
  // gate (the host reads it once; downstream just reads this). Absent ⇒ undeclared. Stored rather
  // than re-derived so `list` can report it offline and for remote plugins, whose config-entry
  // specifier (a github:/https URL) can't be resolved back to a package.json after the fact.
  readonly matbotRuntime?: readonly Runtime[];
}
