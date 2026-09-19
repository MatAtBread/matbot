import {
  getPluginNameForSpecifier, installPrincipalCarrier, createConstantPrincipalCarrier,
  installUsageCarrier, createSerialUsageCarrier, isMissingSecretError, loadPlugins,
  unloadPlugin as unloadPluginFn, ProviderRegistryImpl, applyProviderPatch, assembleMachine, preScanStorage,
} from '@matatbread/matbot-core';
import type {
  MatbotMachine, ProviderConfig, Vault, PluginResolver, PromptFn, MatbotPlugin, Principal, Runtime, ProviderPatch,
} from '@matatbread/matbot-plugin-api';
import { defaultGate } from '@matatbread/matbot-default-gate';
import { BrowserStorageBackend, LocalStorageVault } from '@matatbread/matbot-browser';
import { runProviderSetup, type AvailableProvider, type ProviderDraft } from './setup.js';
import { createBrowserProviderTool, createBrowserToolTypeIndex, extractToolContracts, collectContractAliases } from '@matatbread/matbot-browser';
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
  /** Read-only floor for plugin settings, keyed by plugin NAME (the settings namespace) — the browser
   *  analogue of `default_settings:` in matbot.yaml, baked into the bundle. A stored value always wins
   *  and nothing writes back here, so a bundle rebuild is the only thing that changes a default. */
  defaultSettings?: Record<string, Record<string, unknown>>;
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

  // The boot vault. A plugin may `register('Vault', impl)` over it (e.g. a Drive-backed one).
  const bootVault: Vault = new LocalStorageVault();

  // Store a wizard draft: key in the vault under a derived name, persist the config (with a ${ref},
  // never the raw key) to localStorage, and return the runnable config. A self-contained provider
  // (no endpoint/key — e.g. a local demo adapter) persists neither: only model + module.
  const persistDraft = async (draft: ProviderDraft, vault: Vault): Promise<ProviderConfig> => {
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
    const cfg = await persistDraft(await runProviderSetup(config.availableProviders, { cancelable: false }), bootVault);
    providers.set(cfg.name, cfg);
  }

  const providerSpecs = [...new Set([...providers.values()].map(p => p.module))];
  const preScanned = await preScanStorage([...providerSpecs, ...config.plugins].map(spec => ({ spec, importSpec: spec })), '');

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

  const host = (machine: () => MatbotMachine) => ({
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
        // Collect the remote's own arm-union aliases across all its files first: a contract member and the
        // `type X = ToolContract<…> | …` it names need not be in the same file, or in scan order.
        const remoteSources = remote.sources ?? [];
        const remoteAliases: Record<string, string> = {};
        for (const s of remoteSources) Object.assign(remoteAliases, collectContractAliases(s));
        for (const s of remoteSources) toolTypeIndex.addContracts(extractToolContracts(s, remoteAliases));
        // Carry the declared matbotRuntime so the loader can gate a node-only remote before import and
        // stamp plugin.matbotRuntime (which `list` reports — a blob: importSpec can't be re-read later).
        req = { spec: specifier, importSpec: remote.spec, ...(remote.runtimes !== undefined ? { runtimes: remote.runtimes } : {}) };
      }
      // bustCache=false: the in-browser loader has no disk to re-read, and the query stamp toFreshUrl
      // appends would corrupt a blob:/mbmod: specifier (those don't take query strings) — making the
      // import reject. A remote spec is a freshly fetched blob, so it's already fresh; baked specs
      // re-import their existing blob. (True reload in the browser is a realm reload, by design.)
      const plugin = (await loadPlugins([req], machine(), /* bustCache */ false, prompt, /* onLoadError */ 'throw'))[0];
      if (plugin === undefined) throw new Error(`No plugin loaded for specifier "${specifier}"`);
      return plugin;
    },
    async unloadPlugin(specifier: string): Promise<boolean> {
      const name = getPluginNameForSpecifier(specifier) ?? specNames[specifier];
      if (name === undefined) { console.warn(`[matbot] No loaded plugin for specifier "${specifier}"`); return false; }
      return unloadPluginFn(name, machine());
    },
    resolver,
    isSubAgent: () => false,
    TypeScriptStripper: { strip: stripTypeScript },
  });

  const { services, loaded } = assembleMachine({
    // IndexedDB + OPFS: the boot base, and the revert target when a swapped-in backend's plugin unloads.
    bootBackend:     new BrowserStorageBackend(),
    preScanned,
    vault:           bootVault,
    providers,
    gate:            defaultGate,
    defaultSettings: config.defaultSettings !== undefined ? new Map(Object.entries(config.defaultSettings)) : undefined,
    // A missing secret is asked for, once, and persisted — the browser has no .env to edit.
    resolveSecret:   resolveInteractive,
    version:         env.harnessVersion ?? '?',
    host,
  });

  // Registry-driven ToolTypeIndex (the node tool-types plugin is node-only): derives a .d.ts from live
  // tools' toolContract/inputSchema so function-tools' `types` action returns real declarations. Seeded with
  // the assembler-baked contracts so built-in tools carry real params+result (not just `unknown`) — the same
  // wire TS as node. No tsc, so check() is a no-op (guess-and-run). function-tools reads it per-call.
  const toolTypeIndex: BrowserToolTypeIndexHandle = createBrowserToolTypeIndex(services, env.toolContracts);
  void services.register('ToolTypeIndex', toolTypeIndex);

  // Apply a provider draft: persist it (config → localStorage, key → vault), load the adapter plugin
  // if new, canonicalise its module to the plugin name, and register it in the live providers map.
  // Shared by the wizard (UI), the runtime "+ Add provider" bridge, and the `provider` tool (LLM).
  const applyDraft = async (draft: ProviderDraft): Promise<string> => {
    const cfg = await persistDraft(draft, services.Vault);
    let name = getPluginNameForSpecifier(cfg.module);
    if (name === undefined) {
      await loadPlugins([cfg.module], services);
      name = getPluginNameForSpecifier(cfg.module);
    }
    providers.register(name !== undefined ? { ...cfg, module: name } : cfg);
    return cfg.name;
  };
  // Patch an existing profile: merge, persist, re-register. No draft and no vault call — `update`
  // carries no credential, so the stored `${ref}` (or its absence) rides through untouched, and the
  // adapter cannot change, so nothing needs loading. A *baked* provider gets persisted to localStorage
  // by this, which is right: the seed overlay reads persisted profiles over baked ones, so the edit is
  // an override that survives a reload rather than one the next boot silently discards.
  const updateProvider = async (name: string, patch: ProviderPatch): Promise<boolean> => {
    const cur = providers.get(name);
    if (cur === undefined) return false;
    const next = applyProviderPatch(cur, patch);
    savePersistedProvider(next);
    providers.register(next);
    return true;
  };

  const removeProvider = async (name: string): Promise<boolean> => {
    if (!providers.has(name)) return false;
    providers.remove(name);
    removePersistedProvider(name);
    return true;
  };

  // The portable `provider` tool — list/add/remove over the same persistence the wizard uses.
  services.tools.register(createBrowserProviderTool({
    available: config.availableProviders,
    list: () => [...providers.values()].map(p => ({
      name: p.name, module: p.module, model: p.model,
      ...(p.endpoint   !== undefined ? { endpoint:   p.endpoint   } : {}),
      ...(p.parameters !== undefined ? { parameters: p.parameters } : {}),
      // Reported because `update` can set it: a field a caller can change but not read back is one it
      // cannot reason about, which is the whole reason `update` refuses to touch credentials.
      ...(p.maxRounds  !== undefined ? { maxRounds:  p.maxRounds  } : {}),
      hasCredentials: p.credentials?.['apiKey'] !== undefined,
    })),
    add:    applyDraft,
    update: updateProvider,
    remove: removeProvider,
  }));

  // Let the frontend offer "add another provider" from the UI (runs the wizard form).
  (globalThis as unknown as Record<string, unknown>).__mbProviders = {
    add:  async () => applyDraft(await runProviderSetup(config.availableProviders, { title: 'Add a provider', cancelable: true })),
    list: () => [...providers.keys()],
  };

  // Then the rest — frontends, tools, storage, knowledge, hooks. The frontend plugin mounts the UI.
  await loadPlugins(config.plugins, services);
  loaded();

  console.warn('[matbot] web runtime ready —', services.tools.list().length, 'tools,', providers.size, 'providers.');
}
