import {
  createSessionRunner, HookRegistry, SystemContextRegistryImpl, ToolRegistryImpl, ProviderRegistryImpl,
  instantiateProvider, getPluginNameForSpecifier, recordServiceKey,
  installPrincipalCarrier, createConstantPrincipalCarrier,
  installUsageCarrier, createSerialUsageCarrier, recordUsage,
  createMessage, isMissingSecretError, loadPlugins,
  unloadPlugin as unloadPluginFn, unifyServices,
  forwardingProxy, makeSwappable, singleTurnRequest, createSingleTurnTool, createAboutMatbotTool,
  createMountTable, onContextQuiesce, flushIfQuiescent,
} from '@matatbread/matbot-core';
import type {
  MatbotMachine, MatbotServices, Store, Session, ProviderConfig, ProviderAdapter,
  PluginSettings, Vault, SessionRunner, KnowledgeIndex,
  PluginResolver, StorageBackend, FileStore, PromptFn, MatbotPlugin, Principal, Runtime, SwapFn, Usage,
} from '@matatbread/matbot-plugin-api';
import { LookupKnowledgeIndex } from '@matatbread/matbot-core';
import { BrowserStorageBackend, LocalStorageVault } from '@matatbread/matbot-browser';
import { runProviderSetup, type AvailableProvider, type ProviderDraft } from './setup.js';
import { createBrowserProviderTool, createBrowserToolTypeIndex, extractToolContracts } from '@matatbread/matbot-browser';
import type { BrowserToolTypeIndexHandle } from '@matatbread/matbot-browser';

// Browser TypeScript type-stripper (the TypeScriptStripper the realm provides). The bundle deliberately
// does not inline sucrase (~700 KB per page); mirror the loader and lazy-load it from a CDN on first use,
// then cache. Node uses its built-in stripTypeScriptTypes instead. Async because of the lazy fetch.
const SUCRASE_URL = 'https://esm.sh/sucrase@3.35.1';
type SucraseOptions = { transforms: string[]; disableESTransforms?: boolean; keepUnusedImports?: boolean };
type SucraseTransform = (src: string, opts: SucraseOptions) => { code: string };
let _sucraseTransform: SucraseTransform | undefined;
const stripTypeScript = async (source: string): Promise<string> => {
  if (_sucraseTransform === undefined) {
    const mod = await import(SUCRASE_URL) as { transform: SucraseTransform };
    _sucraseTransform = mod.transform;
  }
  // Strip types ONLY: disableESTransforms leaves `??`/`?.` as native syntax (else sucrase rewrites them to
  // `_nullishCoalesce`/`_optionalChain` helpers — which break when the output is wrapped as an expression,
  // e.g. function-tools' `return (async function …)`, since the injected helper decls become named function
  // expressions out of scope). keepUnusedImports keeps value imports verbatim, matching node's stripper.
  return _sucraseTransform(source, { transforms: ['typescript'], disableESTransforms: true, keepUnusedImports: true }).code;
};

/** Shape of the inlined config baked into the artifact (the browser analogue of matbot.yaml). */
export interface BrowserConfig {
  plugins:   string[];                                    // importable specifiers (synthetic ids)
  providers: Record<string, Omit<ProviderConfig, 'name'>>; // module is already an importable specifier
  /** Adapter types the startup wizard can offer when no provider is configured. */
  availableProviders: AvailableProvider[];
  /** Baked-but-idle plugins (the browser analogue of node's on-disk packages): present in the
   *  artifact + import map but not auto-loaded, offered for on-demand load by package name. */
  availablePlugins?: { name: string; specifier: string; matbotRuntime?: readonly Runtime[]; description?: string }[];
  defaultProvider?: string;
  /** Boot identity for this single-principal realm. Absent ⇒ the anonymous web user.
   *  A user-associated bundle (served per-tenant) bakes the tenant's identity here. */
  principal?: Principal;
}

const PROVIDERS_KEY = 'matbot.providers';

function loadPersistedProviders(): Record<string, Omit<ProviderConfig, 'name'>> {
  try {
    const raw = globalThis.localStorage?.getItem(PROVIDERS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Omit<ProviderConfig, 'name'>>) : {};
  } catch { return {}; }
}

function savePersistedProvider(cfg: ProviderConfig): void {
  const cur = loadPersistedProviders();
  const { name, ...rest } = cfg;
  cur[name] = rest;
  try { globalThis.localStorage?.setItem(PROVIDERS_KEY, JSON.stringify(cur)); } catch { /* unavailable */ }
}

function removePersistedProvider(name: string): void {
  const cur = loadPersistedProviders();
  if (!(name in cur)) return;
  delete cur[name];
  try { globalThis.localStorage?.setItem(PROVIDERS_KEY, JSON.stringify(cur)); } catch { /* unavailable */ }
}

/** Host services the in-page loader provides to the bootstrap (see loader.js / __mbLoader). */
export interface LoaderApi {
  /** Fetch a remote .ts plugin, type-strip it, and return a specifier importable right now, plus the
   *  name and declared matbotRuntime read from its sibling package.json, plus the RAW (pre-strip) source
   *  of each fetched module — so the host can scan `ToolContracts` augmentations for wire contracts. */
  loadRemote(url: string): Promise<{ spec: string; name: string; sources?: string[]; runtimes?: readonly Runtime[] }>;
}

export interface BootEnv {
  config:    BrowserConfig;
  /** specifier → canonical plugin name, baked by the assembler so the resolver needn't walk a tree. */
  specNames: Record<string, string>;
  /** specifier → declared matbotRuntime, baked by the assembler; absent entry means "not declared". */
  specRuntimes?: Record<string, readonly Runtime[]>;
  /** specifier → package.json version, baked by the assembler; absent entry means "couldn't read". */
  specVersions?: Record<string, string>;
  /** The web-bundle's own package version, baked by the assembler — reported by `about_matbot`. */
  harnessVersion?: string;
  /** Per-tool wire contracts ({ params, result }) the assembler derived with the node TypeScript compiler
   *  at build time (the browser has no compiler/fs). Fed to the browser ToolTypeIndex so built-in tools
   *  carry the SAME real TS contracts in their wire descriptions as on node. */
  toolContracts?: Record<string, { params: string; result: string }>;
  loader:    LoaderApi;
}

const NEVER_ABORT = new AbortController().signal;
const WEB_USER: Principal = { id: 'web-user', type: 'user' };

/** Resolve `${NAME}` placeholders, prompting (once, persisted) for any the vault is missing. */
async function resolveInteractive(ref: string, vault: Vault): Promise<string> {
  for (;;) {
    try {
      return await vault.resolve(ref);
    } catch (e) {
      if (!isMissingSecretError(e)) throw e;
      for (const name of e.missingKeys) {
        const val = globalThis.prompt?.(`matbot needs the secret "${name}" (e.g. an API key):`) ?? '';
        if (!val.trim()) throw new Error(`No value provided for required secret "${name}".`);
        await vault.writeSecret(name, val.trim());
      }
    }
  }
}

async function resolveCredentials(creds: Record<string, string>, vault: Vault): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) out[k] = await resolveInteractive(v, vault);
  return out;
}

export async function boot(env: BootEnv): Promise<void> {
  const { config, specNames, loader } = env;
  const specRuntimes = env.specRuntimes ?? {};
  const specVersions = env.specVersions ?? {};

  // One identity for the whole realm — the browser is single-principal, so the carrier is constant
  // and `runAs` is a passthrough (no AsyncLocalStorage needed; see CLAUDE.md "Platform split").
  // The realm's identity comes from config (a per-tenant bundle bakes it); WEB_USER is the
  // anonymous default.
  installPrincipalCarrier(createConstantPrincipalCarrier(config.principal ?? WEB_USER));
  // Token accounting needs a per-turn sink even though identity is constant; the serial carrier is
  // correct here because the browser runs one turn at a time (no async-context isolation to do).
  installUsageCarrier(createSerialUsageCarrier());

  // Vault behind a capture-safe proxy (like StorageBackend/KnowledgeIndex): a plugin may
  // `register('Vault', impl)` to swap in a different secret store (e.g. a Drive-backed one), and
  // every captured reference — complete(), resolveProvider(), the session runner — follows the swap
  // because resolution is lazy/per-turn through the proxy. The default boots from localStorage.
  let activeVault: Vault = new LocalStorageVault();
  const vault = forwardingProxy<Vault>(() => activeVault);

  // Store a wizard draft: key in the vault under a derived name, persist the config (with a ${ref},
  // never the raw key) to localStorage, and return the runnable config. A self-contained provider
  // (no endpoint/key — e.g. a local demo adapter) persists neither: only model + module.
  const persistDraft = async (draft: ProviderDraft): Promise<ProviderConfig> => {
    let credentials: Record<string, string> | undefined;
    if (draft.apiKey) {
      const varName = 'APIKEY_' + draft.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      // createSecret, not writeSecret: the entered value may already be a key name (a vault
      // substitution the user typed instead of the secret) or a value already stored under another
      // name — reference whatever name it canonicalises to, only minting APIKEY_<NAME> for a genuinely
      // new value. Mirrors the node `provider` tool.
      const keyName = await vault.createSecret(varName, draft.apiKey);
      credentials = { apiKey: '${' + keyName + '}' };
    }
    const cfg: ProviderConfig = {
      name:   draft.name,
      module: draft.module,
      model:  draft.model,
      ...(draft.endpoint   ? { endpoint: draft.endpoint } : {}),
      ...(credentials      ? { credentials }              : {}),
      ...(draft.parameters && Object.keys(draft.parameters).length > 0
        ? { parameters: draft.parameters as NonNullable<ProviderConfig['parameters']> }
        : {}),
    };
    savePersistedProvider(cfg);
    return cfg;
  };

  // The live provider registry mirrors matbot.yaml's, name-keyed. Baked providers (if any) are overlaid
  // by anything the user configured in a previous session. Build the seed map first so the registry
  // snapshots it as the boot baseline (what `revert` restores to); its ReadonlyMap surface serves reads,
  // and register/remove/revert are the sanctioned write path.
  const providerSeed = new Map<string, ProviderConfig>();
  for (const [name, cfg] of Object.entries(config.providers))         providerSeed.set(name, { ...cfg, name });
  for (const [name, cfg] of Object.entries(loadPersistedProviders())) {
    // A provider persisted by an OLDER bundle may carry a build-specific synthetic `mbmod:` module id
    // that no longer exists in this build's import map. Left as-is it imports as an unknown-scheme URL
    // (the `mbmod:` CORS/ERR_FAILED boot failure). Repair a still-known synthetic id to its stable
    // package name (what the wizard now persists); drop a stale-across-builds one with a clear notice
    // rather than seeding a guaranteed-broken provider. A plain package name passes through untouched.
    let module = cfg.module;
    if (module.startsWith('mbmod:')) {
      const canonical = specNames[module];
      if (canonical === undefined) {
        console.warn(`[matbot] provider "${name}" was saved with a stale, build-specific module ("${module}") that this build can't resolve — skipping it. Re-add the provider to fix.`);
        continue;
      }
      module = canonical;
    }
    providerSeed.set(name, { ...cfg, name, module });
  }
  const providers = new ProviderRegistryImpl(providerSeed);

  // First run (or cleared storage): collect the full provider config — name, adapter, URL, model, key.
  if (providers.size === 0) {
    const cfg = await persistDraft(await runProviderSetup(config.availableProviders, { cancelable: false }));
    providers.set(cfg.name, cfg);
  }

  // ── Storage backend: IndexedDB + OPFS, discovered from a plugin or defaulted ──────────────
  let activeStorageBackend: StorageBackend | undefined;
  // The config entry of the plugin whose storageBackend the pre-scan opened, if any. Recorded against
  // its plugin name once the loader has resolved names, so its unload reverts storage like a register().
  let storageBootSpec: string | undefined;
  const providerSpecs = [...new Set([...providers.values()].map(p => p.module))];
  for (const spec of [...providerSpecs, ...config.plugins]) {
    try {
      const mod  = await import(/* @vite-ignore */ spec) as Record<string, unknown>;
      const plug = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
      if (plug?.storageBackend !== undefined) { activeStorageBackend = await plug.storageBackend.open(''); storageBootSpec = spec; break; }
    } catch { /* loadPlugins will surface load errors */ }
  }

  // The host's own boot base (OPFS/IDB) — the revert target when a swapped-in StorageBackend's plugin
  // unloads. With no pre-scan backend it *is* the active backend; a pre-scanned one is plugin-owned
  // (see storageBootSpec), so unloading it lands back here.
  const bootBackend: StorageBackend = new BrowserStorageBackend();
  activeStorageBackend ??= bootBackend;

  // ── Swappable store/file proxies (verbatim from the node bootstrap: register('StorageBackend')
  //    re-targets every captured reference) ───────────────────────────────────────────────────
  type AnyStore = Store<{ id: string; version: string }>;
  // forwardingProxy/makeSwappable are shared with the CLI (capture-safe service swap).
  const storeProxies = new Map<string, [AnyStore, SwapFn<AnyStore>]>();
  const createStore = <T extends { id: string; version: string }>(namespace: string): Store<T> => {
    let entry = storeProxies.get(namespace);
    if (entry === undefined) {
      entry = makeSwappable<AnyStore>(activeStorageBackend!.createStore(namespace));
      storeProxies.set(namespace, entry);
    }
    return entry[0] as Store<T>;
  };
  const store = createStore<Session>('sessions');
  const [fileStore, swapFiles] = makeSwappable<FileStore>(activeStorageBackend.fileStore);

  // ── Registries ────────────────────────────────────────────────────────────────────────────
  const toolReg          = new ToolRegistryImpl();
  const hookReg          = new HookRegistry();
  const systemContextReg = new SystemContextRegistryImpl();
  const serviceRegistry  = new Map<string, unknown>();

  let knowledgeImpl: KnowledgeIndex = new LookupKnowledgeIndex();
  // Capture-safe handles (see forwardingProxy): a captured reference, including a destructure like
  // `const { KnowledgeIndex, StorageBackend } = services`, follows register()-driven swaps.
  const knowledgeProxy      = forwardingProxy<KnowledgeIndex>(() => knowledgeImpl);
  const storageBackendProxy = forwardingProxy<StorageBackend>(() => activeStorageBackend);

  // Boot defaults captured for revert-on-unregister (mirrors the CLI host): a swap-key reverts here
  // when its plugin is unloaded, instead of dangling on the now-gone impl. (bootBackend is captured
  // above, before the pre-scan defaulting, so a config backend never poses as the host base.)
  const bootVault                   = activeVault;
  const bootKnowledge               = knowledgeImpl;

  // Re-point every store proxy + the file proxy at `next`. Returns whether anything actually changed,
  // so the caller can skip a redundant `mounted` emit. Synchronous: the repoint completes before this
  // returns, so readers see `next` at once and the `mounted` emit can fire immediately. The displaced
  // impl is closed in the *background* — a slow or throwing close() must never gate the swap or suppress
  // the mounted notification. Driven only from the quiescent-edge flush below — never mid-turn.
  const swapStorage = (next: StorageBackend): boolean => {
    const removed = activeStorageBackend;
    if (removed === next) return false;
    activeStorageBackend = next;
    for (const [ns, [, swap]] of storeProxies) swap(next.createStore(ns));
    swapFiles(next.fileStore);
    void Promise.resolve(removed?.close?.()).catch(e => console.error('[matbot] closing displaced StorageBackend:', e));
    return true;
  };

  // Deferred StorageBackend swap (mirrors the CLI host): register/unregister('StorageBackend') stage the
  // desired backend (last write wins — a slot, not a queue) and ask the context-switch machinery to land
  // it at the next quiescent edge, so a swap never splits a compare-and-swap across two backends.
  // The mount table batches mount notifications to the quiescent edge: register/unregister mark a key
  // dirty; the edge computes each key's net presence transition (mount / remount / committed unload) and
  // multicasts to that key's subscribers. A reload (unregister+register within one turn) collapses to a
  // single remount. Notification timing is deliberately unspecified — see the `Mounted` contract.
  const mountTable = createMountTable(() => services);
  let pendingSwap: { next: StorageBackend } | undefined;
  const stageSwap = (next: StorageBackend): void => {
    pendingSwap = { next };
    flushIfQuiescent();
  };
  onContextQuiesce(() => {
    if (pendingSwap !== undefined) {
      const { next } = pendingSwap;
      pendingSwap = undefined;
      if (swapStorage(next)) mountTable.markDirty('StorageBackend');
    }
    mountTable.flush();
  });
  const swapKnowledge = (next: KnowledgeIndex): void => {
    const prev = knowledgeImpl;
    if (prev === next) return;
    knowledgeImpl = next;
    if (prev.entries !== undefined) for (const e of prev.entries()) void next.index(e);
  };

  const resolver: PluginResolver = {
    async identify(specifier: string): Promise<string> {
      if (specNames[specifier] !== undefined) return specNames[specifier]!;
      const last = (specifier.split('?')[0] ?? specifier).replace(/\/+$/, '').split('/').pop() ?? specifier;
      return last.replace(/\.[^.]+$/, '') || specifier;
    },
    // Baked by the assembler from each plugin's package.json; absent means "not declared", so the
    // loader imports and falls back to load/rollback. A remote .ts added at runtime is undeclared.
    async runtimes(specifier: string): Promise<readonly Runtime[] | undefined> {
      return specRuntimes[specifier];
    },
    // Baked by the assembler from each plugin's package.json; absent means "couldn't read".
    async version(specifier: string): Promise<string | undefined> {
      return specVersions[specifier];
    },
  };

  let sessionRunner: SessionRunner | undefined;

  const baseServices: MatbotMachine = {
    settings(): PluginSettings {
      throw new Error('settings() is only available within a plugin scope (use the services passed to setup()).');
    },
    createStore,
    get(key) { return serviceRegistry.get(key as string) as never; },
    async register(key, value) {
      // StorageBackend is the system of record: stage it and let the quiescent edge apply it (idle →
      // now; mid-turn → at turn end) — its mount notification is marked dirty there, after the swap
      // lands. The other swap-keys repoint immediately, then mark dirty so the edge multicasts the mount.
      if (key === 'StorageBackend')      stageSwap(value as StorageBackend);
      else if (key === 'KnowledgeIndex') swapKnowledge(value as KnowledgeIndex);
      else if (key === 'Vault')          activeVault = value as Vault;
      else serviceRegistry.set(key as string, value);
      if (key !== 'StorageBackend') { mountTable.markDirty(key); flushIfQuiescent(); }
    },
    // Symmetric with register: a swap-key reverts to the app's captured boot default instead of
    // dangling on the unloaded plugin's impl; everything else is a plain registry delete. Marking dirty
    // lets the edge deliver a committed unload (or, if re-registered before the edge, a single remount).
    unregister(key: string) {
      if (key === 'StorageBackend')      stageSwap(bootBackend);
      else if (key === 'KnowledgeIndex') knowledgeImpl = bootKnowledge;
      else if (key === 'Vault')          activeVault = bootVault;
      else serviceRegistry.delete(key);
      if (key !== 'StorageBackend') { mountTable.markDirty(key as keyof MatbotServices); flushIfQuiescent(); }
    },
    registerFrontend() { /* bound per-plugin in setupPlugin's scope; base is a no-op */ },

    async complete(req) {
      const rawCfg = providers.get(req.provider);
      if (rawCfg === undefined) throw new Error(`complete(): unknown provider "${req.provider}". Available: ${[...providers.keys()].join(', ')}`);
      const resolved: ProviderConfig = {
        ...rawCfg,
        ...(rawCfg.credentials !== undefined ? { credentials: await resolveCredentials(rawCfg.credentials, vault) } : {}),
        ...(rawCfg.endpoint    !== undefined ? { endpoint: await resolveInteractive(rawCfg.endpoint, vault) } : {}),
      };
      const adpt = await instantiateProvider(services, resolved);
      if (adpt === null) throw new Error(`complete(): provider "${req.provider}" has no loadable adapter (module "${resolved.module}").`);
      const msgs = req.system !== undefined
        ? [createMessage({ role: 'system', content: [{ type: 'text', text: req.system }], traceId: crypto.randomUUID() }), ...req.messages]
        : req.messages;
      let text = '';
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      for await (const ev of adpt.complete(msgs, resolved, [], req.signal ?? NEVER_ABORT)) {
        if (ev.type === 'text-delta') text += ev.delta;
        if (ev.type === 'usage') {
          usage = {
            inputTokens:  ev.inputTokens,
            outputTokens: ev.outputTokens,
            ...(ev.costUsd              !== undefined ? { costUsd:             ev.costUsd              } : {}),
            ...(ev.cacheReadTokens     !== undefined ? { cacheReadTokens:     ev.cacheReadTokens     } : {}),
            ...(ev.cacheCreationTokens !== undefined ? { cacheCreationTokens: ev.cacheCreationTokens } : {}),
          };
        }
      }
      // Report into the ambient usage sink: a tool running this completion has its spend attributed to
      // the tool call by the runner. No-op outside any tool scope.
      recordUsage(req.provider, usage);
      return { text, usage };
    },

    async singleTurn(req) {
      return this.complete(singleTurnRequest(req));
    },

    async loadPlugin(specifier: string, prompt?: PromptFn): Promise<MatbotPlugin> {
      // A runtime add of a remote .ts (URL or root-absolute path) is fetched and type-stripped by the
      // in-page loader into an ephemeral blob: URL; baked baseline specifiers are already importable
      // via the import map. For a remote, we import the blob but record the *source* URL as the
      // plugin's specifier (via { spec, importSpec }) — the blob is per-load and meaningless across
      // reloads, whereas the source URL is what `plugin list` should show and reload/remove address.
      let req: string | { spec: string; importSpec: string; runtimes?: readonly Runtime[] } = specifier;
      if (/^https?:\/\//.test(specifier) || (specifier.startsWith('/') && !specifier.startsWith('mbmod:'))) {
        const remote = await loader.loadRemote(specifier);
        specNames[specifier] = remote.name;   // identify()/unload resolve by the source URL (= spec)
        // Scan the remote's RAW source for `ToolContracts` augmentations (type-only — stripped from the
        // executable blob) so its tools get real params+result TS in their wire descriptions, like built-ins.
        for (const s of remote.sources ?? []) toolTypeIndex.addContracts(extractToolContracts(s));
        // Carry the declared matbotRuntime so the loader can gate a node-only remote before import and
        // stamp plugin.matbotRuntime (which `list` reports — a blob: importSpec can't be re-read later).
        req = { spec: specifier, importSpec: remote.spec, ...(remote.runtimes !== undefined ? { runtimes: remote.runtimes } : {}) };
      }
      // bustCache=false: the in-browser loader has no disk to re-read, and the query stamp toFreshUrl
      // appends would corrupt a blob:/mbmod: specifier (those don't take query strings) — making the
      // import reject. A remote spec is a freshly fetched blob, so it's already fresh; baked specs
      // re-import their existing blob. (True reload in the browser is a realm reload, by design.)
      const loaded = await loadPlugins([req], services, /* bustCache */ false, prompt, /* onLoadError */ 'throw');
      const plugin = loaded[0];
      if (plugin === undefined) throw new Error(`No plugin loaded for specifier "${specifier}"`);
      return plugin;
    },
    async unloadPlugin(specifier: string): Promise<boolean> {
      const name = getPluginNameForSpecifier(specifier) ?? (specNames[specifier] !== undefined ? specNames[specifier] : undefined);
      if (name === undefined) { console.warn(`[matbot] No loaded plugin for specifier "${specifier}"`); return false; }
      return unloadPluginFn(name, services);
    },

    resolver,
    providers,
    mounted: mountTable.mounted,
    get StorageBackend() { return activeStorageBackend === undefined ? undefined : storageBackendProxy; },
    sessions: store,
    get run() { return sessionRunner; },
    files: fileStore,
    Vault: vault,
    hooks:         hookReg,
    tools:         toolReg,
    systemContext: systemContextReg,
    isSubAgent: () => false,
    get KnowledgeIndex() { return knowledgeProxy; },
    TypeScriptStripper: { strip: stripTypeScript },
  };
  const services: MatbotMachine = unifyServices(baseServices);

  // Registry-driven ToolTypeIndex (the node tool-types plugin is node-only): derives a .d.ts from live
  // tools' toolContract/inputSchema so function-tools' `types` action returns real declarations. Seeded with
  // the assembler-baked contracts so built-in tools carry real params+result (not just `unknown`) — the same
  // wire TS as node. No tsc, so check() is a no-op (guess-and-run). function-tools reads it per-call.
  const toolTypeIndex: BrowserToolTypeIndexHandle = createBrowserToolTypeIndex(services, env.toolContracts);
  void services.register('ToolTypeIndex', toolTypeIndex);

  const resolveProvider = async (name: string): Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null> => {
    const cfg = providers.get(name);
    if (cfg === undefined) return null;
    const resolved: ProviderConfig = {
      ...cfg,
      ...(cfg.credentials !== undefined ? { credentials: await resolveCredentials(cfg.credentials, vault) } : {}),
      ...(cfg.endpoint    !== undefined ? { endpoint: await resolveInteractive(cfg.endpoint, vault) } : {}),
    };
    const adapter = await instantiateProvider(services, resolved);
    return adapter === null ? null : { adapter, config: resolved };
  };

  sessionRunner = createSessionRunner({
    store,
    resolveProvider,
    tools:         toolReg,
    hooks:         hookReg,
    systemContext: systemContextReg,
    vault,
    files:         fileStore,
    loadPlugin:    services.loadPlugin.bind(services),
    unloadPlugin:  services.unloadPlugin.bind(services),
    toolTypeIndex: () => services.ToolTypeIndex,   // fold each tool's wire contract into its description at dispatch
    toolPresenter: () => services.ToolPresenter,   // resolved live: a tool-search/deferral plugin registers it after boot
    steeringPolicy: () => services.SteeringPolicy, // resolved live: a steering plugin registers it after boot
  });

  // Load provider plugins first as a warm-up so the first turn needn't load its adapter mid-response.
  // No canonicalisation: instantiateProvider resolves a specifier to its loaded plugin's factory at use
  // time and leaves the profile's `module` as written, so the provider list reports the source truth.
  // TEST(provider-registry): pre-scan disabled to exercise on-demand loading. Restore this line to re-enable.
  // await loadPlugins(providerSpecs, services);

  // Apply a provider draft: persist it (config → localStorage, key → vault), load the adapter plugin
  // if new, canonicalise its module to the plugin name, and register it in the live providers map.
  // Shared by the wizard (UI), the runtime "+ Add provider" bridge, and the `provider` tool (LLM).
  const applyDraft = async (draft: ProviderDraft): Promise<string> => {
    const cfg = await persistDraft(draft);
    let name = getPluginNameForSpecifier(cfg.module);
    if (name === undefined) {
      await loadPlugins([cfg.module], services);
      name = getPluginNameForSpecifier(cfg.module);
    }
    providers.register(name !== undefined ? { ...cfg, module: name } : cfg);
    return cfg.name;
  };
  const removeProvider = async (name: string): Promise<boolean> => {
    if (!providers.has(name)) return false;
    providers.remove(name);
    removePersistedProvider(name);
    return true;
  };

  // The portable `provider` tool — list/add/remove over the same persistence the wizard uses.
  toolReg.register(createBrowserProviderTool({
    available: config.availableProviders,
    list: () => [...providers.values()].map(p => ({
      name: p.name, module: p.module, model: p.model,
      ...(p.endpoint   !== undefined ? { endpoint:   p.endpoint   } : {}),
      ...(p.parameters !== undefined ? { parameters: p.parameters } : {}),
      hasKey: p.credentials?.['apiKey'] !== undefined,
    })),
    add:    applyDraft,
    remove: removeProvider,
  }));

  // single_turn: the same core tool the node app registers — a one-shot completion against any
  // configured provider (or the current turn's, when omitted). Pure (services only), so it runs
  // identically in the browser realm.
  toolReg.register(createSingleTurnTool(services));

  // about_matbot: the harness's own version + description. The harness isn't a plugin, so this singleton
  // fact gets a dedicated tool; the assembler bakes the web-bundle's own package version into the env.
  toolReg.register(createAboutMatbotTool(env.harnessVersion ?? '?'));

  // Let the frontend offer "add another provider" from the UI (runs the wizard form).
  (globalThis as unknown as Record<string, unknown>).__mbProviders = {
    add:  async () => applyDraft(await runProviderSetup(config.availableProviders, { title: 'Add a provider', cancelable: true })),
    list: () => [...providers.keys()],
  };

  // Then the rest — frontends, tools, storage, knowledge, hooks. The frontend plugin mounts the UI.
  await loadPlugins(config.plugins, services);

  // The pre-scan opened a manifest storageBackend before the loader knew the plugin's name, bypassing
  // the scoped register() that records a service key. Attribute it now, so unloading that plugin reverts
  // storage to the host base and closes the backend — unload-equal to a runtime register().
  if (storageBootSpec !== undefined) {
    const name = getPluginNameForSpecifier(storageBootSpec);
    if (name !== undefined) recordServiceKey(name, 'StorageBackend');
  }

  console.warn('[matbot] web runtime ready —', toolReg.list().length, 'tools,', providers.size, 'providers.');
}
