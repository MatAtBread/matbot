import {
  createSessionRunner, HookRegistry, SystemContextRegistryImpl,
  resolveProviderFactory, getPluginNameForSpecifier,
  installPrincipalCarrier, createConstantPrincipalCarrier,
  createMessage, MissingSecretError, loadPlugins,
  unloadPlugin as unloadPluginFn, unifyServices,
} from '@matatbread/matbot-core';
import type {
  MatbotServices, Store, Session, Tool, ProviderConfig, ProviderAdapter,
  PluginSettings, ToolRegistry, Vault, SessionRunner, KnowledgeIndex,
  PluginResolver, StorageBackend, FileStore, PromptFn, MatbotPlugin, Principal, Runtime,
} from '@matatbread/matbot-plugin-api';
import { LookupKnowledgeIndex } from '@matatbread/matbot-knowledge';
import { BrowserStorageBackend, LocalStorageVault } from '@matatbread/matbot-browser';
import { runProviderSetup, type AvailableProvider, type ProviderDraft } from './setup.js';
import { createBrowserProviderTool } from './provider-tool.js';

/** Shape of the inlined config baked into the artifact (the browser analogue of matbot.yaml). */
export interface BrowserConfig {
  plugins:   string[];                                    // importable specifiers (synthetic ids)
  providers: Record<string, Omit<ProviderConfig, 'name'>>; // module is already an importable specifier
  /** Adapter types the startup wizard can offer when no provider is configured. */
  availableProviders: AvailableProvider[];
  defaultProvider?: string;
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
  /** Fetch a remote .ts plugin, type-strip it, and return a specifier importable right now. */
  loadRemote(url: string): Promise<{ spec: string; name: string }>;
}

export interface BootEnv {
  config:    BrowserConfig;
  /** specifier → canonical plugin name, baked by the assembler so the resolver needn't walk a tree. */
  specNames: Record<string, string>;
  /** specifier → declared matbotRuntime, baked by the assembler; absent entry means "not declared". */
  specRuntimes?: Record<string, readonly Runtime[]>;
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
      if (!(e instanceof MissingSecretError)) throw e;
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

  // One identity for the whole realm — the browser is single-principal, so the carrier is constant
  // and `runAs` is a passthrough (no AsyncLocalStorage needed; see CLAUDE.md "Platform split").
  installPrincipalCarrier(createConstantPrincipalCarrier(WEB_USER));

  const vault: Vault = new LocalStorageVault();

  // Store a wizard draft: key in the vault under a derived name, persist the config (with a ${ref},
  // never the raw key) to localStorage, and return the runnable config.
  const persistDraft = async (draft: ProviderDraft): Promise<ProviderConfig> => {
    const keyName = 'APIKEY_' + draft.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    await vault.writeSecret(keyName, draft.apiKey);
    const cfg: ProviderConfig = {
      name:        draft.name,
      module:      draft.module,
      model:       draft.model,
      endpoint:    draft.endpoint,
      credentials: { apiKey: '${' + keyName + '}' },
    };
    savePersistedProvider(cfg);
    return cfg;
  };

  // providers map mirrors matbot.yaml's, name-keyed; canonicalised below once provider plugins load.
  // Baked providers (if any) are overlaid by anything the user configured in a previous session.
  const providers = new Map<string, ProviderConfig>();
  for (const [name, cfg] of Object.entries(config.providers))         providers.set(name, { ...cfg, name });
  for (const [name, cfg] of Object.entries(loadPersistedProviders())) providers.set(name, { ...cfg, name });

  // First run (or cleared storage): collect the full provider config — name, adapter, URL, model, key.
  if (providers.size === 0) {
    const cfg = await persistDraft(await runProviderSetup(config.availableProviders, { cancelable: false }));
    providers.set(cfg.name, cfg);
  }

  // ── Storage backend: IndexedDB + OPFS, discovered from a plugin or defaulted ──────────────
  let activeStorageBackend: StorageBackend | undefined;
  const providerSpecs = [...new Set([...providers.values()].map(p => p.module))];
  for (const spec of [...providerSpecs, ...config.plugins]) {
    try {
      const mod  = await import(/* @vite-ignore */ spec) as Record<string, unknown>;
      const plug = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
      if (plug?.storageBackend !== undefined) { activeStorageBackend = await plug.storageBackend.open(''); break; }
    } catch { /* loadPlugins will surface load errors */ }
  }
  activeStorageBackend ??= new BrowserStorageBackend();

  // ── Swappable store/file proxies (verbatim from the node bootstrap: register('StorageBackend')
  //    re-targets every captured reference) ───────────────────────────────────────────────────
  type AnyStore = Store<{ id: string; version: string }>;
  type SwapFn<T extends object> = (next: T) => void;
  // A capture-safe forwarding proxy: every trap routes to whatever `getCurrent()` returns *now*, so a
  // reference captured before a register()-driven swap keeps resolving to the live impl. getPrototypeOf
  // is forwarded so `instanceof` sees the real impl; ownKeys + getOwnPropertyDescriptor keep object
  // spread faithful. Methods bind to the current impl. A nullish current reads as empty.
  function forwardingProxy<T extends object>(getCurrent: () => T | undefined): T {
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

  function makeSwappable<T extends object>(initial: T): [T, SwapFn<T>] {
    let current = initial;
    return [forwardingProxy<T>(() => current), (next: T) => { current = next; }];
  }

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
  const toolMap = new Map<string, Tool>();
  const toolReg: ToolRegistry = {
    register: (t: Tool) => { toolMap.set(t.name, t); },
    remove:   (n: string) => { toolMap.delete(n); },
    resolve:  (n) => toolMap.get(n) ?? null,
    list:     () => [...toolMap.values()],
    removeByPlugin: (pluginName: string) => {
      for (const [name, tool] of toolMap) if (tool.pluginName === pluginName) toolMap.delete(name);
    },
  };
  const hookReg          = new HookRegistry();
  const systemContextReg = new SystemContextRegistryImpl();
  const serviceRegistry  = new Map<string, unknown>();

  let knowledgeImpl: KnowledgeIndex = new LookupKnowledgeIndex();
  // Capture-safe handles (see forwardingProxy): a captured reference, including a destructure like
  // `const { KnowledgeIndex, StorageBackend } = services`, follows register()-driven swaps.
  const knowledgeProxy      = forwardingProxy<KnowledgeIndex>(() => knowledgeImpl);
  const storageBackendProxy = forwardingProxy<StorageBackend>(() => activeStorageBackend);

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
  };

  let sessionRunner: SessionRunner | undefined;

  const baseServices: MatbotServices = {
    settings(): PluginSettings {
      throw new Error('settings() is only available within a plugin scope (use the services passed to setup()).');
    },
    createStore,
    get(key) { return serviceRegistry.get(key as string) as never; },
    async register(key, value) {
      if (key === 'StorageBackend') {
        const next = value as StorageBackend;
        for (const [ns, [, swap]] of storeProxies) swap(next.createStore(ns));
        swapFiles(next.fileStore);
        const old = activeStorageBackend;
        activeStorageBackend = next;
        await old?.close?.();
      } else if (key === 'KnowledgeIndex') {
        const prev = knowledgeImpl;
        knowledgeImpl = value as KnowledgeIndex;
        if (prev.entries !== undefined) for (const e of prev.entries()) void (value as KnowledgeIndex).index(e);
      } else {
        serviceRegistry.set(key as string, value);
      }
    },
    unregister(key: string) { serviceRegistry.delete(key); },
    registerFrontend() { /* bound per-plugin in setupPlugin's scope; base is a no-op */ },

    async complete(req) {
      const rawCfg = providers.get(req.provider);
      if (rawCfg === undefined) throw new Error(`complete(): unknown provider "${req.provider}". Available: ${[...providers.keys()].join(', ')}`);
      const resolved: ProviderConfig = {
        ...rawCfg,
        ...(rawCfg.credentials !== undefined ? { credentials: await resolveCredentials(rawCfg.credentials, vault) } : {}),
        ...(rawCfg.endpoint    !== undefined ? { endpoint: await resolveInteractive(rawCfg.endpoint, vault) } : {}),
      };
      const adpt = resolveProviderFactory(resolved.module)(resolved);
      const msgs = req.system !== undefined
        ? [createMessage({ role: 'system', content: [{ type: 'text', text: req.system }], traceId: crypto.randomUUID() }), ...req.messages]
        : req.messages;
      let text = '', inputTokens = 0, outputTokens = 0;
      for await (const ev of adpt.complete(msgs, resolved, [], req.signal ?? NEVER_ABORT)) {
        if (ev.type === 'text-delta') text += ev.delta;
        if (ev.type === 'usage') { inputTokens = ev.inputTokens; outputTokens = ev.outputTokens; }
      }
      return { text, usage: { inputTokens, outputTokens } };
    },

    async loadPlugin(specifier: string, prompt?: PromptFn): Promise<MatbotPlugin> {
      let spec = specifier;
      // A runtime add of a remote .ts (URL or root-absolute path) is fetched and type-stripped by the
      // in-page loader; baked baseline specifiers are already importable via the import map.
      if (/^https?:\/\//.test(specifier) || (specifier.startsWith('/') && !specifier.startsWith('mbmod:'))) {
        const remote = await loader.loadRemote(specifier);
        spec = remote.spec;
        specNames[spec] = remote.name;
      }
      // bustCache=false: the in-browser loader has no disk to re-read, and the query stamp toFreshUrl
      // appends would corrupt a blob:/mbmod: specifier (those don't take query strings) — making the
      // import reject. A remote spec is a freshly fetched blob, so it's already fresh; baked specs
      // re-import their existing blob. (True reload in the browser is a realm reload, by design.)
      const loaded = await loadPlugins([spec], services, /* bustCache */ false, prompt, /* onIncompatibleRuntime */ 'throw');
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
    get StorageBackend() { return activeStorageBackend === undefined ? undefined : storageBackendProxy; },
    sessions: store,
    get run() { return sessionRunner; },
    files: fileStore,
    vault,
    hooks:         hookReg,
    tools:         toolReg,
    systemContext: systemContextReg,
    get KnowledgeIndex() { return knowledgeProxy; },
  };
  const services: MatbotServices = unifyServices(baseServices);

  const resolveProvider = async (name: string): Promise<{ adapter: ProviderAdapter; config: ProviderConfig } | null> => {
    const cfg = providers.get(name);
    if (cfg === undefined) return null;
    const resolved: ProviderConfig = {
      ...cfg,
      ...(cfg.credentials !== undefined ? { credentials: await resolveCredentials(cfg.credentials, vault) } : {}),
      ...(cfg.endpoint    !== undefined ? { endpoint: await resolveInteractive(cfg.endpoint, vault) } : {}),
    };
    return { adapter: resolveProviderFactory(resolved.module)(resolved), config: resolved };
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
  });

  // Load provider plugins first, then canonicalise each provider's module to the loaded plugin's
  // name so resolveProviderFactory (keyed by plugin name) finds the adapter regardless of specifier.
  await loadPlugins(providerSpecs, services);
  for (const [key, cfg] of providers) {
    const pluginName = getPluginNameForSpecifier(cfg.module);
    if (pluginName !== undefined && pluginName !== cfg.module) providers.set(key, { ...cfg, module: pluginName });
  }

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
    providers.set(cfg.name, name !== undefined ? { ...cfg, module: name } : cfg);
    return cfg.name;
  };
  const removeProvider = async (name: string): Promise<boolean> => {
    if (!providers.has(name)) return false;
    providers.delete(name);
    removePersistedProvider(name);
    return true;
  };

  // The portable `provider` tool — list/add/remove over the same persistence the wizard uses.
  toolReg.register(createBrowserProviderTool({
    available: config.availableProviders,
    list: () => [...providers.values()].map(p => ({
      name: p.name, module: p.module, model: p.model,
      ...(p.endpoint !== undefined ? { endpoint: p.endpoint } : {}),
      hasKey: p.credentials?.['apiKey'] !== undefined,
    })),
    add:    applyDraft,
    remove: removeProvider,
  }));

  // Let the frontend offer "add another provider" from the UI (runs the wizard form).
  (globalThis as unknown as Record<string, unknown>).__mbProviders = {
    add:  async () => applyDraft(await runProviderSetup(config.availableProviders, { title: 'Add a provider', cancelable: true })),
    list: () => [...providers.keys()],
  };

  // Then the rest — frontends, tools, storage, knowledge, hooks. The frontend plugin mounts the UI.
  await loadPlugins(config.plugins, services);

  console.warn('[matbot] web runtime ready —', toolReg.list().length, 'tools,', providers.size, 'providers.');
}
