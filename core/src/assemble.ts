import type {
  MatbotMachine, MatbotServices, MatbotPlugin, Store, Session, FileStore, StorageBackend, Vault, Notifier,
  KnowledgeIndex, PermissionGate, PluginSettings, ProviderConfig, ProviderAdapter, SessionRunner, Tool, Usage,
} from '@matatbread/matbot-plugin-api';
import {
  forwardingProxy, makeSwappable, createMountTable, scheduleAtEdge, createNotifier, recordUsage, singleTurnRequest,
  HookRegistry,
} from '@matatbread/matbot-plugin-api/host';
import type { SwapFn } from '@matatbread/matbot-plugin-api/host';
import { notifyingStore, createMessage } from '@matatbread/matbot-plugin-api';
import { mediumGuard } from './storage-base/medium-guard.js';
import { unifyServices } from './plugin.js';
import { instantiateProvider, recordServiceKey, getPluginNameForSpecifier, getRegisteredPlugins } from './registry.js';
import { installSettingsDefaults, installSettingsNotifier, makePluginSettings, settingsDefaultNamespaces } from './settings.js';
import type { SettingsDoc } from './settings.js';
import { ToolRegistryImpl } from './tool-registry.js';
import type { ToolInputValidator } from './tool-registry.js';
import type { ProviderRegistryImpl } from './provider-registry.js';
import { SystemContextRegistryImpl } from './system-context.js';
import { LookupKnowledgeIndex } from './knowledge/index.js';
import { createSessionRunner } from './session-runner.js';
import { createSingleTurnTool } from './single-turn.js';
import { createAboutMatbotTool } from './about.js';
import { addUsage } from './usage.js';

/** A storage backend a configured plugin's manifest supplied at boot, and the config entry it came from. */
export interface PreScannedStorage {
  backend: StorageBackend;
  spec:    string;
}

/**
 * Open the first configured plugin's manifest `storageBackend`, before any store exists. Import failures
 * are left for the loader to report. Node caches the imported modules, so the later load is free.
 */
export async function preScanStorage(
  specs: readonly { spec: string; importSpec: string }[],
  dir:   string,
): Promise<PreScannedStorage | undefined> {
  for (const { spec, importSpec } of specs) {
    try {
      const mod  = await import(/* @vite-ignore */ importSpec) as Record<string, unknown>;
      const plug = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
      if (plug?.storageBackend !== undefined) return { backend: await plug.storageBackend.open(dir), spec };
    } catch { /* the loader surfaces it */ }
  }
  return undefined;
}

/** The host's default permission policy, and the tools that inspect it (`@matatbread/matbot-default-gate`). */
export interface HostGate {
  namespace: string;
  create(settings: PluginSettings): PermissionGate;
  tools(settings: PluginSettings): Tool[];
}

/** The machine members only a host can supply. */
export type HostMembers =
  Pick<MatbotMachine, 'loadPlugin' | 'unloadPlugin' | 'resolver' | 'isSubAgent' | 'TypeScriptStripper' | 'workdir' | 'configPath'>;

export interface AssembleOptions {
  /** The host's own storage: the revert target when a plugin's StorageBackend is unregistered. */
  bootBackend:      StorageBackend;
  preScanned?:      PreScannedStorage | undefined;
  /** The boot vault, behind a swappable proxy like every other swap-member. */
  vault:            Vault;
  providers:        ProviderRegistryImpl;
  gate:             HostGate;
  defaultSettings?: ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined;
  /** Registry values present from boot, which an unregister reverts to rather than deleting. */
  seed?:            Partial<MatbotServices>;
  builtinTools?:    Tool[];
  /** Resolve one `${NAME}` reference; the browser prompts for a missing secret. Defaults to the vault. */
  resolveSecret?(ref: string, vault: Vault): Promise<string>;
  /** Reported by `about_matbot`. */
  version:          string;
  /** Called with a late-bound handle, since these members call back into the machine being built. */
  host(machine: () => MatbotMachine): HostMembers;
}

export interface AssembledMachine {
  services: MatbotMachine;
  /** A session runner over any store — the shared one is `services.run`. */
  makeRunner(store: Store<Session>): SessionRunner;
  /** Call once the configured plugins have loaded. */
  loaded(): void;
}

const NEVER_ABORT = new AbortController().signal;
type AnyStore = Store<{ id: string; version: string }>;

/**
 * Stand a machine up: the swappable services and their boot defaults, the stores, the registries, the
 * deferred storage swap and mount table, the session runner and the core tools. The one expression of
 * the boot graph, so a step added here reaches every host. What differs by platform — carriers, where
 * storage and secrets live, how a plugin is acquired — is the host's to pass in.
 *
 * The host installs its principal and usage carriers first: nothing here reads an identity, but the
 * runner and every plugin will.
 */
export function assembleMachine(opts: AssembleOptions): AssembledMachine {
  const { bootBackend, preScanned, providers } = opts;
  installSettingsDefaults(opts.defaultSettings);

  // Swap-members sit behind capture-safe proxies, so a captured reference — including a destructure
  // like `const { KnowledgeIndex, StorageBackend } = services` — follows a register()-driven swap.
  let activeVault = opts.vault;
  const vault = forwardingProxy<Vault>(() => activeVault);
  let activeNotifier: Notifier = createNotifier('core');
  const notifier = forwardingProxy<Notifier>(() => activeNotifier);
  // Settings writes announce on the same bus. The proxy, not the impl, so a registered distributed
  // Notifier relays them too.
  installSettingsNotifier(notifier);
  let knowledgeImpl: KnowledgeIndex = new LookupKnowledgeIndex();
  const knowledge = forwardingProxy<KnowledgeIndex>(() => knowledgeImpl);

  // ── Storage ───────────────────────────────────────────────────────────────────────────────────────
  let activeBackend: StorageBackend = preScanned?.backend ?? bootBackend;
  // Held only to say so, once, when a plugin displaces it — see swapStorage.
  let preScanBackend = preScanned?.backend;
  const backend = forwardingProxy<StorageBackend>(() => activeBackend);

  const storeProxies = new Map<string, [AnyStore, SwapFn<AnyStore>]>();
  // Bumped by every swap, and read by the medium guard. A document handed out under one generation
  // cannot be written back under another: nothing is migrated between backends, so that write would
  // move it, silently, into a backend that never issued it.
  let storageGeneration = 0;
  const guarded = new Map<string, AnyStore>();
  const createStore = <T extends { id: string; version: string }>(namespace: string): Store<T> => {
    let entry = storeProxies.get(namespace);
    if (entry === undefined) {
      entry = makeSwappable<AnyStore>(activeBackend.createStore(namespace));
      storeProxies.set(namespace, entry);
    }
    // Guard OUTSIDE the swap proxy: one stable object per namespace across every swap, so a captured
    // store reference keeps working and the guard sees each call whichever backend is current.
    let store = guarded.get(namespace);
    if (store === undefined) {
      store = mediumGuard<{ id: string; version: string }>(entry[0], () => storageGeneration, namespace);
      guarded.set(namespace, store);
    }
    return store as Store<T>;
  };
  const [fileStore, swapFiles] = makeSwappable<FileStore>(activeBackend.fileStore);
  // Every session write announces itself: the namespace has many writers (the turn pump, session_action,
  // session_edit, a session minted over HTTP), and one wrapper covers them all, including the next.
  const sessions = notifyingStore(createStore<Session>('sessions'), notifier, 'sessions', 'session');

  // Re-point every store proxy and the file proxy at `next`. Synchronous, so readers see `next` at once;
  // the displaced backend is closed in the background, because a slow or throwing close() (node:sqlite's
  // rejecting on a still-open statement) must never gate the swap or suppress its mount notification.
  // Driven only from the quiescent edge, never mid-turn.
  const swapStorage = (next: StorageBackend): boolean => {
    const removed = activeBackend;
    if (removed === next) return false;
    // Only ONE backend is ever active, and a plugin registering one displaces whatever the boot pre-scan
    // opened — silently, since the swap is supported and the loser leaves nothing but an orphaned file.
    // Said once, naming the plugin, at the moment it stops being true.
    if (removed === preScanBackend && next !== bootBackend) {
      preScanBackend = undefined;
      console.warn(
        `[matbot] storage: the backend opened at startup by "${preScanned?.spec}" has been replaced by another ` +
        `plugin's storage backend. Only one is ever active and nothing is migrated between them, so anything ` +
        `it already wrote is no longer read. Configure just one storage plugin to remove this ambiguity.`,
      );
    }
    activeBackend = next;
    storageGeneration++;
    for (const [ns, [, swap]] of storeProxies) swap(next.createStore(ns));
    swapFiles(next.fileStore);
    void Promise.resolve(removed.close?.()).catch(e => console.error('[matbot] closing displaced StorageBackend:', e));
    return true;
  };

  // ── Registries ────────────────────────────────────────────────────────────────────────────────────
  // The host's file area doubles as the media store, so attachments work with no plugin. Seeded into the
  // registry rather than spelled on the base object, because `unifyServices` resolves an own property
  // first — a member spelled there is one `register()` could never reach.
  const seed: Partial<MatbotServices> = { MediaStore: fileStore, ...opts.seed };
  const serviceRegistry = new Map<string, unknown>(Object.entries(seed));
  // The validator lookup is late-bound and read per call: one is registered by a plugin long after the
  // builtins are seeded, and may be unloaded again. It wraps the executor, so every door — the runner,
  // `POST /tools/:name`, `invokeTool` — is covered by one wrapper rather than a hook on the model's path.
  const tools = new ToolRegistryImpl(opts.builtinTools, notifier,
    () => serviceRegistry.get('ToolCallValidator') as ToolInputValidator | undefined);
  const hooks = new HookRegistry();
  const systemContext = new SystemContextRegistryImpl();

  // The installation's permission policy. Deliberately NOT behind a forwardingProxy: the documented way
  // to replace a policy is to capture the one displaced and delegate to it, and a capture-safe proxy
  // would make that capture resolve to the capturing gate itself — which then calls itself until the
  // stack overflows. A getter keeps the member read late-bound; every consumer resolves it per call.
  const gateSettings = makePluginSettings(createStore<SettingsDoc>('settings'), opts.gate.namespace);
  let activeGate = opts.gate.create(gateSettings);

  const boot = { vault: activeVault, knowledge: knowledgeImpl, notifier: activeNotifier, gate: activeGate };

  // ── The quiescent edge ────────────────────────────────────────────────────────────────────────────
  // A StorageBackend swap waits for it, since swapping the system of record under a running turn would
  // split a compare-and-swap across two backends. The mount table batches mount notifications to it:
  // register/unregister mark a key dirty, and the edge multicasts each key's net transition, so a
  // reload within one turn collapses to a single remount.
  const mountTable = createMountTable(() => services);
  // A last-write-wins slot read at fire time, so three registers before an edge install one backend. One
  // callback also orders the swap ahead of the mount flush, so the remount it marks lands in that edge.
  let pendingSwap: StorageBackend | undefined;
  const scheduleEdge = scheduleAtEdge(() => {
    if (pendingSwap !== undefined) {
      const next = pendingSwap;
      pendingSwap = undefined;
      if (swapStorage(next)) mountTable.markDirty('StorageBackend');
    }
    mountTable.flush();
  });
  const stageSwap = (next: StorageBackend): void => { pendingSwap = next; scheduleEdge(); };
  const swapKnowledge = (next: KnowledgeIndex): void => {
    const prev = knowledgeImpl;
    if (prev === next) return;
    knowledgeImpl = next;
    if (prev.entries !== undefined) for (const e of prev.entries()) void next.index(e);
  };

  const resolveSecret = (ref: string): Promise<string> => opts.resolveSecret?.(ref, vault) ?? vault.resolve(ref);
  const resolveConfig = async (cfg: ProviderConfig): Promise<ProviderConfig> => {
    let credentials: Record<string, string> | undefined;
    if (cfg.credentials !== undefined) {
      credentials = {};
      for (const [k, v] of Object.entries(cfg.credentials)) credentials[k] = await resolveSecret(v);
    }
    return {
      ...cfg,
      ...(credentials  !== undefined ? { credentials } : {}),
      ...(cfg.endpoint !== undefined ? { endpoint: await resolveSecret(cfg.endpoint) } : {}),
    };
  };

  let runner: SessionRunner | undefined;

  const baseServices: MatbotMachine = {
    // Plugins always receive the plugin-scoped override built in setupPlugin; the base is never called.
    settings(): PluginSettings {
      throw new Error('settings() is only available within a plugin scope (use the services passed to setup()).');
    },
    createStore,
    get(key) { return serviceRegistry.get(key as string) as never; },
    // StorageBackend is staged for the quiescent edge, which marks its mount dirty once the swap lands;
    // the other swap-keys repoint at once and mark dirty for the edge to multicast.
    async register(key, value) {
      if (key === 'StorageBackend')      stageSwap(value as StorageBackend);
      else if (key === 'KnowledgeIndex') swapKnowledge(value as KnowledgeIndex);
      else if (key === 'Vault')          activeVault = value as Vault;
      else if (key === 'Notifier')       activeNotifier = value as Notifier;
      else if (key === 'PermissionGate') activeGate = value as PermissionGate;
      else serviceRegistry.set(key as string, value);
      if (key !== 'StorageBackend') { mountTable.markDirty(key); scheduleEdge(); }
    },
    // Symmetric with register: a swap-key or seeded key reverts to its boot value rather than dangling on
    // the unloaded plugin's impl — unloading a plugin that put media on S3 leaves attachments working on
    // disk, not off until a restart. Anything else is deleted.
    unregister(key: string) {
      if (key === 'StorageBackend')      stageSwap(bootBackend);
      else if (key === 'KnowledgeIndex') knowledgeImpl = boot.knowledge;
      else if (key === 'Vault')          activeVault = boot.vault;
      else if (key === 'Notifier')       activeNotifier = boot.notifier;
      else if (key === 'PermissionGate') activeGate = boot.gate;
      else if (key in seed)              serviceRegistry.set(key, seed[key as keyof MatbotServices]);
      else serviceRegistry.delete(key);
      if (key !== 'StorageBackend') { mountTable.markDirty(key as keyof MatbotServices); scheduleEdge(); }
    },
    registerFrontend() { /* bound per plugin in setupPlugin's scope */ },

    async complete(req) {
      const raw = providers.get(req.provider);
      if (raw === undefined) throw new Error(`complete(): unknown provider "${req.provider}". Available: ${[...providers.keys()].join(', ')}`);
      const resolved = await resolveConfig({
        ...raw,
        // Per-call overrides shallow-merged over the config's own parameters (request wins).
        ...(req.parameters !== undefined ? { parameters: { ...raw.parameters, ...req.parameters } } : {}),
      });
      const adapter = await instantiateProvider(services, resolved);
      if (adapter === null) throw new Error(`complete(): provider "${req.provider}" has no loadable adapter (module "${resolved.module}").`);
      const messages = req.system !== undefined
        ? [createMessage({ role: 'system', content: [{ type: 'text', text: req.system }], traceId: crypto.randomUUID() }), ...req.messages]
        : req.messages;
      let text = '';
      // Folded as the runner folds a turn's usage, because an adapter may report one call in several
      // parts: anthropic sends input + cache counts on `message_start` and output on `message_delta`.
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      const startedAt = Date.now();
      for await (const ev of adapter.complete(messages, resolved, [], req.signal ?? NEVER_ABORT)) {
        if (ev.type === 'text-delta') text += ev.delta;
        if (ev.type === 'usage')      usage = addUsage(usage, ev);
      }
      // Into the ambient usage sink, so a tool running this completion has its spend attributed to the
      // site in force. Measured here because this is where the call is issued.
      recordUsage(req.provider, usage, { startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
      return { text, usage };
    },
    async singleTurn(req) {
      return this.complete(singleTurnRequest(req));
    },

    ...opts.host(() => services),
    providers,
    mounted:  mountTable.mounted,
    sessions,
    files:    fileStore,
    get run() { return runner; },
    hooks,
    tools,
    systemContext,
    StorageBackend: backend,
    Vault:          vault,
    Notifier:       notifier,
    get PermissionGate() { return activeGate; },
    get KnowledgeIndex() { return knowledge; },
  };
  const services: MatbotMachine = unifyServices(baseServices);

  // Resolved per turn, so it sees live `provider` edits. instantiateProvider force-loads an adapter that
  // is not registered yet, and yields null rather than throwing when it cannot.
  const resolveProvider = async (name: string): Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null> => {
    const cfg = providers.get(name);
    if (cfg === undefined) return null;
    const config  = await resolveConfig(cfg);
    const adapter = await instantiateProvider(services, config);
    return adapter === null ? null : { adapter, config };
  };

  // Services a plugin registers after boot are resolved live, per turn.
  const makeRunner = (store: Store<Session>): SessionRunner => createSessionRunner({
    store,
    resolveProvider,
    tools,
    hooks,
    systemContext,
    vault,
    files:          fileStore,
    toolTypeIndex:  () => services.ToolTypeIndex,
    toolPresenter:  () => services.ToolPresenter,
    steeringPolicy: () => services.SteeringPolicy,
    mediaStore:     () => services.MediaStore,
    permissionGate: () => services.PermissionGate,
    ...(services.workdir    !== undefined ? { workdir:    services.workdir }    : {}),
    ...(services.configPath !== undefined ? { configPath: services.configPath } : {}),
    loadPlugin:     services.loadPlugin.bind(services),
    unloadPlugin:   services.unloadPlugin.bind(services),
  });
  runner = makeRunner(sessions);

  // Seeded rather than carried by configured plugins: `gate_action` because a minimal install's first act
  // (adding a plugin or provider) is gated, so inspecting an answer cannot depend on a config line.
  for (const tool of opts.gate.tools(gateSettings)) tools.register(tool);
  tools.register(createSingleTurnTool(services));
  // The harness is not a plugin (no `plugin list` row), so its version gets a tool of its own.
  tools.register(createAboutMatbotTool(opts.version, services));

  const loaded = (): void => {
    // A defaults key is a plugin NAME — loader-derived, not necessarily what `plugins:` spells. One
    // naming nothing loaded is the feature's one silent failure. The gate's namespace is seeded by the
    // host rather than a plugin, and reserved dunder namespaces are not plugins; both are exempt.
    const names = new Set(getRegisteredPlugins().map(p => p.name));
    for (const ns of settingsDefaultNamespaces()) {
      if (names.has(ns) || ns === opts.gate.namespace || (ns.startsWith('__') && ns.endsWith('__'))) continue;
      console.warn(
        `[matbot] default settings name "${ns}", which is not a loaded plugin — they apply only once a plugin ` +
        `of that name loads. Key them by the plugin's package name (\`plugin list\` reports them).`,
      );
    }
    // The pre-scan opened a manifest backend before the loader knew the plugin's name, bypassing the
    // scoped register() that attributes a service key. Attributing it now makes unloading that plugin
    // revert storage to the host base, exactly as for a runtime register().
    const name = preScanned !== undefined ? getPluginNameForSpecifier(preScanned.spec) : undefined;
    if (name !== undefined) recordServiceKey(name, 'StorageBackend');
  };

  return { services, makeRunner, loaded };
}
