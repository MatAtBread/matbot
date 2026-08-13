import type {
  FileStore, Principal, Vault, Message, ModelParameters,
  ProviderAdapter, ProviderConfig, ProviderRegistry, Tool, ToolRegistry, FrontendInfo,
  Store, Session, SystemContextRegistry, KnowledgeIndex, PromptFn, SessionRunner, Usage, HookRegistrar,
  TypeScriptStripper, ToolTypeIndex, ToolPresenter, SteeringPolicy,
} from './types.js';
import type { Notifications, Notifier } from './notify.js';

/**
 * The plugin API contract version: this package's `major.minor`, and nothing else. It sat at `'0.1'`
 * while the package shipped 0.3.x, so it conveyed no information and could not be reasoned about at a
 * version boundary — the point at which it is the only thing every third-party plugin hardcodes.
 *
 * The gate (`checkApiVersion`, in core's registry) reads it as: **major must match exactly** — a
 * mismatch is a hard load failure — and a plugin declaring a *newer minor* than the runtime warns and
 * loads, since it may reach for something absent. Declare it as `apiVersion: PLUGIN_API_VERSION` and it
 * stays right for free; that is what every plugin in this repo does.
 *
 * Bumping 0.1 → 0.4 breaks nothing: at 0.x the major is `'0'` either way, and an older declared minor
 * does not warn. It matters at 1.0.0, where a plugin still declaring `'0.x'` will fail the major check
 * loudly instead of loading against a contract it was never built for.
 */
export const PLUGIN_API_VERSION = '0.4';

// ── Sub-runner types ──────────────────────────────────────────────────────────

export interface CompletionRequest {
  provider:    string;
  messages:    Message[];
  system?:     string;
  /**
   * Per-call parameter overrides, shallow-merged over the named provider's own `parameters` (request
   * wins). For *transient* model behaviour — a lower `temperature` to classify, `thinking` off for a
   * cheap sub-call, a tighter `maxTokens` on a call whose output is parsed rather than shown.
   *
   * The alternative is a near-duplicate provider profile per behaviour, identical to its sibling but
   * for one field, which pushes a caller's transient concern into global, user-editable config and
   * multiplies the profiles a user has to understand. So: **durable properties of a model belong in
   * the provider profile; a single call's behaviour belongs here.** If the same override appears at
   * every call site of a provider, that is the signal it was a profile all along.
   *
   * Honoured by both hosts (CLI + web-bundle), which resolve the merge before handing the config to
   * the adapter; an unrecognised key is the adapter's business, exactly as in a profile.
   */
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
  /** Forwarded verbatim to {@link CompletionRequest.parameters} — same merge, same guidance. */
  parameters?: Partial<ModelParameters>;
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
   * The plugin's package.json `version`, or `undefined` when it can't be read (no package.json, or a
   * remote specifier whose version isn't baked). Read from the same nearest-named-package.json boundary
   * as {@link identify}, so it lives here (host-specific: fs walk on node, baked manifest in the browser)
   * rather than in the platform-neutral loader. Stamped onto {@link MatbotPlugin.version} at load.
   */
  version?(specifier: string): Promise<string | undefined>;
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
 * One of matbot's five open-registry augmentation points — same technique at each; see
 * docs/DEVELOPING.md *Open-registry augmentation* for the shared shape and the rules that follow from it.
 *
 * The registry bucket: the swappable, registerable services, keyed by interface name. This is the
 * `keyof` domain of {@link MatbotRuntime.register}/`get`, and the surface third-party plugins augment
 * (`declare module '@matatbread/matbot-plugin-api' { interface MatbotServices { Foo?: Foo } }`). The
 * four swap-members (`StorageBackend`, `KnowledgeIndex`, `Vault`, `Notifier`) carry a host boot default
 * and revert to it when unregistered; an augmented service is optional and simply drops. Read each as
 * a member (`services.KnowledgeIndex`); swap with register().
 */
export interface MatbotServices {
  readonly StorageBackend?: StorageBackend | undefined;
  /** Optional, node-only tool-type index (a `.d.ts` of what tool calls resolve to), used by code
   *  generators/composers so the model isn't guessing return shapes. Absent where no TS program can run
   *  (the browser); consumers must degrade. Provided by the `tool-types` plugin. See {@link ToolTypeIndex}. */
  readonly ToolTypeIndex?: ToolTypeIndex | undefined;
  /** The live vault — also the `register('Vault', impl)` swap key. Capture-safe behind a proxy, so a
   *  reference held across a swap keeps resolving to the live backend. Always present (boot default). */
  readonly Vault: Vault;
  readonly KnowledgeIndex: KnowledgeIndex;
  /** The notification bus — every "something changed" fact, one fan-out. Also the `register('Notifier',
   *  impl)` swap key: the host boots an in-process broadcaster, a plugin may swap in a distributed one
   *  (and unloading it reverts to the boot default). Capture-safe behind a proxy. Always present.
   *  Within a plugin's `setup()` this is scoped, so published notifications carry that plugin's name.
   *  See {@link Notifier}. */
  readonly Notifier: Notifier;
  /** Optional tool-presentation policy: chooses which tools are advertised to the model per provider
   *  call (a large-library search/deferral plugin registers one). Absent ⇒ the runner advertises the
   *  whole turn snapshot. A plain registered service (not a swap-member); consumed as a member. See
   *  {@link ToolPresenter}. */
  readonly ToolPresenter?: ToolPresenter | undefined;
  /** Optional partition-aware file-watch layer (cross-partition observation + per-connection visibility),
   *  registered by a partitioning storage backend. Absent ⇒ frontends use the plain `fileStore.watch()`.
   *  See {@link WatchVisibility}. */
  readonly WatchVisibility?: WatchVisibility | undefined;
  /** Optional file-partition addressing, registered by the same partitioning storage backend as
   *  {@link WatchVisibility}. Absent ⇒ one undivided file area. See {@link FilePartition}. */
  readonly FilePartition?: FilePartition | undefined;
  /** Optional steering policy: decides how a mid-turn submission under `mode: 'auto'` is disposed
   *  (queue vs interrupt) and supplies the nudge folded onto an interrupt's continuation. Absent ⇒ the
   *  runner uses its own defaults. A plain registered service, consumed by the runner as a member.
   *  See {@link SteeringPolicy}. */
  readonly SteeringPolicy?: SteeringPolicy | undefined;
}

/** The assembled machine: registry services wired to the fixed runtime — what `setup()` receives. */
export type MatbotMachine = MatbotServices & MatbotRuntime;

/**
 * The fixed runtime — microcode, not a service: the agentic loop's primitives (`complete`,
 * `createStore`), the registries you mutate but never swap wholesale (`hooks`, `tools`,
 * `systemContext`, `providers`), plugin lifecycle, and the registry API itself. Not augmentable, not registerable.
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

  /** Host-provided, per-platform TypeScript type-stripper. Always present (every execution environment
   *  supplies one); not registerable/swappable. Use it to erase types from source you compile at runtime
   *  rather than importing a platform-specific stripper. See {@link TypeScriptStripper}. */
  readonly TypeScriptStripper: TypeScriptStripper;

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
   *   services.mounted.observe({ key: 'StorageBackend', signal }, () => this.load());
   *
   *   // depend on a peer service that may not be present yet; seed now if it is, and on each (re)mount
   *   services.mounted.observe({ key: 'SkillManager', replay: true, signal }, m => seed(m));
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

  readonly providers:       ProviderRegistry;
  readonly sessions?:       Store<Session>;
  /** Per-session turn serialiser. Frontends submit and observe through this rather than calling
   *  runSession directly, so concurrent submits queue instead of clobbering the session. */
  readonly run?:            SessionRunner | undefined;
  readonly files?:          FileStore;
  readonly hooks:           HookRegistrar;
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
  /** Ends the subscription *earlier* than the observing plugin's unload. Optional because it is a
   *  narrowing convenience, not the cleanup path: the host binds every plugin-scoped observe() to that
   *  plugin's load extent, so an interest can never outlive its owner. Pass one only when the
   *  subscription's life is shorter than the plugin's (a per-session cache, a one-shot latch). */
  readonly signal?:    AbortSignal;
  /** The *dependency's* teardown: fired when `key` is committed-unloaded (removed and not replaced by
   *  the quiescent edge) while this consumer lives on. The stream continues — a later remount re-fires
   *  `handler`. Drop any captured ref to the gone service here. */
  readonly onUnmount?: (machine: MatbotMachine) => void | Promise<void>;
}

/** The mount-table consumer facet exposed on {@link MatbotRuntime.mounted}. `observe` (not `consume`)
 *  so the verb `consume` means exactly one thing repo-wide — the detached stream drain on
 *  {@link Subscribable}; this keyed, replay/onUnmount, edge-batched delivery is its own paradigm. */
export interface Mounted {
  observe<K extends keyof MatbotServices>(
    options: MountConsumeOptions<K>,
    handler: (machine: MountedMachine<K>) => void | Promise<void>,
  ): void;
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

/**
 * What a {@link WatchVisibility} predicate decides on. A named object rather than positional parameters
 * because `kind`/`namespace`/`id` are three adjacent strings around two `Principal`s — an ordering an
 * implementation could get wrong silently.
 *
 * Populated by whoever consults the predicate; a frontend firehose fills it from the notification it is
 * about to fan out.
 */
export interface VisibilityQuery {
  /** The principal asking — the owner of the connection this fan-out would reach. */
  viewer:     Principal;
  /** The notification's `kind`. Present so an implementation can apply a policy PER KIND: some kinds are
   *  global, some are checked against the recipient (`viewer`), some against the sender (`origin`). Typed
   *  as the registry key for narrowing, but **open at runtime** like every `kind` — a plugin outside this
   *  build, or a bridged remote, can supply one, so `default` your switch and never assume exhaustiveness. */
  kind:       keyof Notifications;
  /** Routing namespace of the changed item — the axis a profile isolates. Absent when the kind addresses
   *  no item (a `RegistryChange`, or a plugin kind carrying a measurement or an external event). */
  namespace?: string;
  /** Store id of the changed item; drives the shared-in check. Absent with `namespace`. */
  id?:        string;
  /** Whose data the fact is about — `NotificationBase.principal`, the ownership axis, NOT attribution.
   *  Absent ⇒ a global fact. */
  origin?:    Principal;
}

/**
 * The per-connection visibility layer, registered by a storage backend that partitions per principal (the
 * profiles backend). Consumed by a frontend firehose to decide, per SSE connection, whether a given
 * notification is visible to that connection's principal. Absent ⇒ no partitioning, and every connection
 * sees everything.
 *
 * **The predicate is consulted for EVERY kind, and decides for itself which it filters.** It used to be
 * reached only for an `ItemChange` carrying a principal, because the caller gated on that — which left
 * every plugin-defined kind fanned out unfiltered with no hook capable of stopping it, and made `kind` a
 * constant not worth passing. Moving that judgement here is the point: routing a partitioned namespace and
 * addressing a notification to a recipient are two different policies, and only the implementation knows
 * which of its kinds want which. An implementation that has nothing to say about a kind returns `true`.
 */
export interface WatchVisibility {
  /**
   * The per-connection visibility predicate for ANY partitioned event stream (files, skills, …): would a
   * connection owned by `q.viewer` see this change? For a partitioning backend, true iff the viewer routes
   * `q.namespace` to the same partition as `q.origin` — `route(viewer, ns) === route(origin, ns)` — OR the
   * item is shared INTO the viewer's partition (the owner edits a shared-in item: origin=owner ≠ the
   * viewer's route, yet the viewer holds a live link to it). That yields the intended behavior uniformly:
   * global/base events for namespaces the viewer has NOT isolated, own-partition events for those it has,
   * plus live updates to items shared in from another partition. `q.origin` may be a partition principal
   * (files, tagged by the merge) or the acting principal (skills, stamped at write) — routing both sides
   * makes either correct.
   *
   * Fail OPEN on anything you do not recognise: a kind you have no policy for, or a query with no
   * `namespace`/`origin` to route on. A predicate that guesses `false` silently drops another party's
   * events; one that returns `true` leaves them exactly as unfiltered as they were before it registered.
   */
  visible(q: VisibilityQuery): boolean;
}

/**
 * Addressing for the file area, registered by a storage backend that partitions it per principal (the
 * profiles backend). It exists so a caller that must name a file area OUT OF BAND — in a URL a plain
 * browser GET will replay, with no ambient principal and no header to carry one — can do so without
 * reimplementing the backend's routing.
 *
 * **The token is a partition, never a principal.** The two are not interchangeable: one principal may
 * hold several profiles, and a profile may alias a namespace onto a third profile's partition, so the
 * partition serving a principal's files is not derivable from the principal id. Minting the token from
 * the identity in force — the bug this replaces — attached an addressable partition to files that were
 * in the shared base area, and would have pointed at an empty partition the moment one was created
 * under that name.
 *
 * `current` and `enter` are one round trip and must stay each other's inverse: whatever `current`
 * returns, `enter` puts a reader back into the area those bytes were written to. Both live here rather
 * than on the consumer because only the backend knows how a token resolves — a frontend that
 * synthesised a principal from the token would be guessing at the routing again, one layer up.
 */
export interface FilePartition {
  /** The partition the CURRENT principal's file area resolves to, as an opaque token — or `undefined`
   *  for the shared base area, which needs no addressing (a bare path already reaches it). Never
   *  interpret the token: it is the backend's, and only `enter` gives it meaning. */
  current(): string | undefined;
  /** Run `fn` reading the file area named by `token` — the inverse of `current`. An unknown token
   *  resolves to whatever that backend serves for one; it is an address, not a capability, so it grants
   *  no access the caller's own gating (a file's `allowed` flag) does not already permit. */
  enter<T>(token: string, fn: () => Promise<T>): Promise<T>;
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
  readonly specifier: string;   // how it was loaded (config entry / pre-resolved)
  /** The stable URL the loader actually imported, minus any reload cache-bust stamp — a `file:` URL
   *  for local/remote-cached plugins, the bare specifier when nothing was pre-resolved. Lets a consumer
   *  map a loaded plugin back to its on-disk source without re-running specifier resolution (e.g.
   *  skills_compiler builds a types program over the live plugin set). Set by the loader; absent only
   *  on hosts that construct MatbotPlugin by hand. */
  readonly resolvedUrl?: string;
  readonly source?:   PluginSource;
  // The package.json `matbotRuntime`, captured at load from the same value used for the pre-import
  // gate (the host reads it once; downstream just reads this). Absent ⇒ undeclared. Stored rather
  // than re-derived so `list` can report it offline and for remote plugins, whose config-entry
  // specifier (a github:/https URL) can't be resolved back to a package.json after the fact.
  readonly matbotRuntime?: readonly Runtime[];
  // The plugin's package.json `version`, read by the resolver at load (fs walk on node; baked manifest
  // in the browser). Absent ⇒ couldn't be read (no package.json, or a remote whose version isn't baked).
  // Loader-established provenance, like `name`/`matbotRuntime` — not the author's to declare.
  readonly version?: string;
}
