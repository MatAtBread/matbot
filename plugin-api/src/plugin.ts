import type {
  FileStore, Vault, Message, ModelParameters,
  ProviderAdapter, ProviderConfig, Tool, ToolRegistry, FrontendInfo,
  Store, Session, SystemContextRegistry, KnowledgeIndex, PromptFn, SessionRunner, Usage,
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
  usage: Usage;
}

export interface SingleTurnRequest {
  provider: string;
  prompt:   string;
  system?:  string;
  signal?:  AbortSignal;
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

/**
 * The registry bucket: the swappable, registerable services, keyed by interface name. This is the
 * `keyof` domain of {@link MatbotRuntime.register}/`get`, and the surface third-party plugins augment
 * (`declare module '@matatbread/matbot-plugin-api' { interface MatbotServices { Foo?: Foo } }`). The
 * core three carry a host boot default and revert to it when unregistered; an augmented service is
 * optional and simply drops. Read each as a member (`services.KnowledgeIndex`); swap with register().
 */
export interface MatbotServices {
  readonly StorageBackend?: StorageBackend | undefined;
  /** The live vault — also the `register('Vault', impl)` swap key. Capture-safe behind a proxy, so a
   *  reference held across a swap keeps resolving to the live backend. Always present (boot default). */
  readonly Vault: Vault;
  readonly KnowledgeIndex: KnowledgeIndex;
}

/** The assembled machine: registry services wired to the fixed runtime — what `setup()` receives. */
export type MatbotMachine = MatbotServices & MatbotRuntime;

/**
 * The fixed runtime — microcode, not a service: the agentic loop's primitives (`complete`,
 * `createStore`), the registries you mutate but never swap wholesale (`hooks`, `tools`,
 * `systemContext`), plugin lifecycle, and the registry API itself. Not augmentable, not registerable.
 */
export interface MatbotRuntime {
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /**
   * Thin convenience over {@link complete}: send a single `prompt` (and optional `system`) to a
   * named provider and get the response, hiding the otherwise-mandatory and meaningless `Message`
   * fields (id/traceId/createdAt) that an out-of-band one-shot call has no use for.
   */
  singleTurn(req: SingleTurnRequest): Promise<CompletionResponse>;

  /** The calling plugin's own settings store. Scoped to the plugin — it cannot reach another's. */
  settings(): PluginSettings;

  /**
   * Hot-load a plugin by specifier into the running process. Returns the loaded plugin.
   * `prompt`, when supplied, resolves tool-name collisions interactively during the new
   * plugin's setup(); the runner injects the triggering session's prompt automatically.
   * `refresh` (default false) forces a remote (github/http) plugin's `.plugins/` cache subtree
   * to be evicted and re-downloaded — a reload of changed upstream source. Cache-first otherwise:
   * a programmatic loader gets the cached copy and stays offline-tolerant.
   */
  loadPlugin(specifier: string, prompt?: PromptFn, refresh?: boolean): Promise<MatbotPlugin>;

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
   * Mount-table notifications: react to a registry service (re)mounting or being unloaded. A plugin
   * needs this iff its setup() reads another service's *current state* to build cached/derived state —
   * skills/triggers cache the StorageBackend's documents; cognition seeds from the SkillManager. A pure
   * map (no setup data; data arrives later as a tool call or hook) needs nothing — resolve the service
   * per-invocation through its proxy/member instead.
   *
   *   // cache the backend's documents; rebuild on every swap (own initial load was in setup())
   *   services.mounted.consume({ key: 'StorageBackend', signal }, () => this.load());
   *
   *   // depend on a peer service that may not be present yet; seed now if it is, and on each (re)mount
   *   services.mounted.consume({ key: 'SkillManager', replay: true, signal }, m => seed(m));
   *
   * Contract guarantees only *eventual, ordered* delivery of each key's net presence transition — it
   * says nothing about timing: a mount may fire synchronously-ish or batch to a later quiescent edge, so
   * never assume a register() is observed inline or at a turn boundary. A reload (unregister+register
   * before the edge) collapses to a single remount; an unregister not replaced by the edge is a
   * committed unload, delivered to `onUnmount` (drop your captured ref there to let the gone plugin's
   * working set be collected). Handlers may re-fire on later remounts, so they must be idempotent.
   */
  readonly mounted: Mounted;

  /**
   * Register a service under a MatbotServices key (the key is the interface name it carries).
   * Well-known keys have dedicated behaviour:
   *   'StorageBackend' — replaces the active storage backend and re-wires all Store proxies.
   *   'KnowledgeIndex' — replaces the active KnowledgeIndex, draining entries from the old one.
   *   'Vault' — replaces the active vault backend and re-points the capture-safe vault proxy, so
   *             references to `services.Vault` / `ctx.vault` keep resolving to the live impl.
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
  readonly files?:          FileStore;
  readonly hooks:           HookRegistry;
  readonly tools:           ToolRegistry;
  readonly systemContext:   SystemContextRegistry;
  /** Default working directory for tool execution. Plugins that create servers should forward this to tool contexts. */
  readonly workdir?:        string;
  /** Absolute path to the loaded config file. Plugins that create servers should forward this to tool contexts. */
  readonly configPath?:     string;

  /**
   * Whether this process is a background sub-agent (spawned by another matbot, not a top-level
   * interactive run). The signal is platform-sourced — the node entry reads it from the environment,
   * the browser realm has no sub-agent notion and returns false (a future WebWorker realm could
   * return true). Plugins use it to suppress work that must be singular per bot identity: e.g. a
   * frontend's long-poll loop, which would otherwise contend with the foreground process on the
   * same upstream connection.
   */
  isSubAgent(): boolean;
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
export function unifyServices(services: MatbotMachine): MatbotMachine {
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

// ── Capture-safe swap proxies ───────────────────────────────────────────────────

export type SwapFn<T extends object> = (next: T) => void;

/**
 * A capture-safe forwarding proxy: every trap routes to whatever `getCurrent()` returns *now*, so a
 * reference captured before a register()-driven swap keeps resolving to the live impl. getPrototypeOf
 * is forwarded so `instanceof` sees the real impl (the StorageBackend identity checks depend on it);
 * ownKeys + getOwnPropertyDescriptor keep object spread faithful. Methods bind to the current impl,
 * not the proxy. A nullish current (an optional service with nothing registered yet) reads as empty.
 */
export function forwardingProxy<T extends object>(getCurrent: () => T | undefined): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const cur = getCurrent();
      if (cur === undefined) return undefined;
      const val = Reflect.get(cur, prop, cur);
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(cur) : val;
    },
    has(_t, prop)    { const cur = getCurrent(); return cur !== undefined && Reflect.has(cur, prop); },
    getPrototypeOf() { const cur = getCurrent(); return cur === undefined ? null : Reflect.getPrototypeOf(cur); },
    ownKeys()        { const cur = getCurrent(); return cur === undefined ? [] : Reflect.ownKeys(cur); },
    getOwnPropertyDescriptor(_t, prop) {
      const cur = getCurrent();
      if (cur === undefined) return undefined;
      const d = Reflect.getOwnPropertyDescriptor(cur, prop);
      if (d !== undefined) d.configurable = true; // Proxy invariant: props absent from the {} target must be configurable.
      return d;
    },
  });
}

/**
 * Returns [proxy, swap]: the Store/FileStore handle plugins capture, plus the fn register() calls to
 * repoint it at a new backend's store. Built on forwardingProxy so capture-safety is uniform.
 */
export function makeSwappable<T extends object>(initial: T): [T, SwapFn<T>] {
  let current = initial;
  return [forwardingProxy<T>(() => current), (next: T) => { current = next; }];
}

// ── Mount table ─────────────────────────────────────────────────────────────────

/** The machine with one registry key narrowed to present — what a keyed mount handler receives. */
export type MountedMachine<K extends keyof MatbotServices> =
  MatbotMachine & { readonly [P in K]-?: NonNullable<MatbotServices[P]> };

export interface MountConsumeOptions<K extends keyof MatbotServices> {
  /** The registry service whose mount transitions this subscription tracks. */
  readonly key:        K;
  /** Fire `handler` once on the next microtask against the *current* machine if `key` is present now
   *  (then on each later remount). Off by default — a cacher that did its initial load in setup() wants
   *  only future transitions; a deferred dependency wants the latch. */
  readonly replay?:    boolean;
  /** Ends the subscription (the consumer's own teardown). */
  readonly signal?:    AbortSignal;
  /** The *dependency's* teardown: fired when `key` is committed-unloaded (removed and not replaced by
   *  the quiescent edge) while this consumer lives on. The stream continues — a later remount re-fires
   *  `handler`. Drop any captured ref to the gone service here. */
  readonly onUnmount?: (machine: MatbotMachine) => void | Promise<void>;
}

/** The mount-table consumer facet exposed on {@link MatbotRuntime.mounted}. */
export interface Mounted {
  consume<K extends keyof MatbotServices>(
    options: MountConsumeOptions<K>,
    handler: (machine: MountedMachine<K>) => void | Promise<void>,
  ): void;
}

/** The host-side mount table: {@link Mounted} for plugins, plus the producer half the host drives from
 *  its register/unregister and quiescent-edge flush. */
export interface MountTable {
  readonly mounted: Mounted;
  /** Record that a key's presence may have changed since the last edge (called by register/unregister). */
  markDirty(key: keyof MatbotServices): void;
  /** At a quiescent edge, compute each dirty key's net presence transition and multicast it. */
  flush(): void;
}

interface MountInterest {
  readonly handler:   (machine: MatbotMachine) => void | Promise<void>;
  readonly onUnmount: ((machine: MatbotMachine) => void | Promise<void>) | undefined;
  readonly signal:    AbortSignal | undefined;
}

function reportMountHandlerError(e: unknown): void {
  console.error('[matbot] mounted handler threw:', e instanceof Error ? e.message : e);
}

/**
 * Build a {@link MountTable} over a lazily-read machine. Notifications batch to the quiescent edge
 * ({@link flush}), where each dirty key's net presence (absent→present = mount, present→present =
 * remount, present→absent = committed unload) is multicast to that key's subscribers. The clock holds
 * the last-committed presence per key, so a reload collapses to one remount and a committed unload is
 * well-defined. Presence is read by member access on the unified machine, which resolves both the core
 * getters (StorageBackend/Vault/KnowledgeIndex) and the registry-backed augmented keys.
 */
export function createMountTable(getMachine: () => MatbotMachine): MountTable {
  const interests = new Map<string, Set<MountInterest>>();
  const committed = new Map<string, boolean>();   // last-committed presence per key (the clock)
  const dirty     = new Set<string>();

  const present = (key: string): boolean => (getMachine() as unknown as Record<string, unknown>)[key] !== undefined;

  const run = (fn: (machine: MatbotMachine) => void | Promise<void>, machine: MatbotMachine): void => {
    try {
      const r = fn(machine);
      if (r instanceof Promise) r.catch(reportMountHandlerError);
    } catch (e) { reportMountHandlerError(e); }
  };

  const mounted: Mounted = {
    consume(options, handler) {
      const { key, replay, signal, onUnmount } = options;
      if (signal?.aborted === true) return;
      const interest: MountInterest = {
        handler:   handler as MountInterest['handler'],
        onUnmount: onUnmount as MountInterest['onUnmount'],
        signal,
      };
      let set = interests.get(key);
      if (set === undefined) { set = new Set(); interests.set(key, set); }
      const subs = set;
      subs.add(interest);
      signal?.addEventListener('abort', () => { subs.delete(interest); }, { once: true });
      // Replay on the next microtask (async-iterator parity — never inline in the consume() frame).
      // Reads the live machine, not `committed`: replay is "current state", separate from the clock.
      if (replay === true) queueMicrotask(() => {
        if (signal?.aborted === true) return;
        if (present(key as string)) run(interest.handler, getMachine());
      });
    },
  };

  return {
    mounted,
    markDirty(key) { dirty.add(key as string); },
    flush() {
      if (dirty.size === 0) return;
      const keys = [...dirty];
      dirty.clear();
      const machine = getMachine();
      for (const key of keys) {
        const before = committed.get(key) ?? false;
        const after  = present(key);
        committed.set(key, after);
        const subs = interests.get(key);
        if (subs === undefined) continue;
        if (after) {
          for (const i of subs) run(i.handler, machine);                                  // mount / remount
        } else if (before) {
          for (const i of subs) if (i.onUnmount !== undefined) run(i.onUnmount, machine);  // committed unload
        }
      }
    },
  };
}

/**
 * Build the one-message CompletionRequest for a {@link MatbotRuntime.singleTurn} call, hiding the
 * otherwise-mandatory and meaningless Message fields (id/traceId/createdAt) an out-of-band one-shot
 * has no use for. Pure; the host invokes its own complete() with the result.
 */
export function singleTurnRequest(req: SingleTurnRequest): CompletionRequest {
  return {
    provider: req.provider,
    messages: [{
      id: '', traceId: '', createdAt: new Date().toISOString(), role: 'user',
      content: [{ type: 'text', text: req.prompt }],
    }],
    ...(req.system !== undefined ? { system: req.system } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  };
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
   * When present, the runtime calls open(dotData) before creating the services object and uses the
   * returned backend for all Store and FileStore creation. The plugin must be listed before any plugin
   * whose setup() calls createStore. The host treats a boot-opened backend as owned by this plugin (as
   * if it had `register('StorageBackend', …)` in setup), so unloading the plugin reverts storage to the
   * host's own base and closes the backend. A backend swapped in *later* via register() does not take
   * effect immediately — see {@link MatbotRuntime.mounted}: it lands at the next quiescent edge so it
   * never splits a turn's compare-and-swap across two backends.
   */
  readonly storageBackend?: {
    open(dotData: string): Promise<StorageBackend>;
  };
  setup?(services: MatbotMachine): Promise<void>;
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
