import type { Store, MatbotMachine, ProviderConfig } from '@matatbread/matbot-plugin-api';
import type { ProviderDraft, ProviderRow, ProviderAdmin, AvailableProvider } from '@matatbread/matbot-browser';

const DOC_ID = 'manifest';

interface ManifestDoc {
  id:        string;
  version:   string;
  providers: ProviderConfig[];
}

/**
 * The Drive-synced provider set, persisted as one doc in the active StorageBackend's `provider-manifest`
 * namespace (Drive, once this plugin is active). Holds each profile exactly as stored — module/model/
 * endpoint/parameters plus a `${NAME}` credential *placeholder*, never the secret (that lives in the
 * DriveVault, keyed independently). Symmetric with {@link DrivePluginSet}: each loader restores its own
 * set on boot, so provider profiles added once Drive is connected reappear on every browser.
 */
export class DriveProviderSet {
  private readonly store: Store<ManifestDoc>;

  constructor(store: Store<ManifestDoc>) {
    this.store = store;
  }

  async list(): Promise<ProviderConfig[]> {
    return (await this.store.get(DOC_ID))?.providers ?? [];
  }

  async add(config: ProviderConfig): Promise<void> {
    const cur = (await this.list()).filter(p => p.name !== config.name);
    await this.store.set(DOC_ID, { id: DOC_ID, version: crypto.randomUUID(), providers: [...cur, config] });
  }

  async remove(name: string): Promise<void> {
    const cur = await this.list();
    await this.store.set(DOC_ID, { id: DOC_ID, version: crypto.randomUUID(), providers: cur.filter(p => p.name !== name) });
  }
}

function bakedAvailableProviders(): AvailableProvider[] {
  const mb = (globalThis as unknown as { __MB__?: { config?: { availableProviders?: AvailableProvider[] } } }).__MB__;
  return mb?.config?.availableProviders ?? [];
}

function credentialVar(name: string): string {
  return `MATBOT_API_KEY_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function toRow(p: ProviderConfig): ProviderRow {
  return {
    name:   p.name,
    module: p.module,
    model:  p.model,
    ...(p.endpoint   !== undefined ? { endpoint:   p.endpoint   } : {}),
    ...(p.parameters !== undefined ? { parameters: p.parameters } : {}),
    hasKey: p.credentials?.['apiKey'] !== undefined,
  };
}

/**
 * A {@link ProviderAdmin} backed by Drive, so the browser `provider` tool ({@link createBrowserProviderTool})
 * syncs profiles across machines. `add` stores the API key in the (already Drive-swapped) vault, persists
 * the profile — with a `${NAME}` placeholder, never the secret — to the Drive manifest, and registers it
 * live; `remove` drops it from both the manifest and the live registry; `list` reports the live set. The
 * adapter catalogue comes from the baked `__MB__.config`, exactly as the browser plugin tool reads its own.
 */
export function driveProviderAdmin(driveSet: DriveProviderSet, services: MatbotMachine): ProviderAdmin {
  return {
    available: bakedAvailableProviders(),
    list: () => [...services.providers.values()].map(toRow),
    async add(draft: ProviderDraft): Promise<string> {
      let credentials: Record<string, string> | undefined;
      if (draft.apiKey) {
        const stored = await services.Vault.createSecret(credentialVar(draft.name), draft.apiKey);
        credentials = { apiKey: `\${${stored}}` };
      }
      const config: ProviderConfig = {
        name:   draft.name,
        module: draft.module,
        model:  draft.model,
        ...(draft.endpoint   ? { endpoint: draft.endpoint }     : {}),
        ...(credentials !== undefined ? { credentials }         : {}),
        ...(draft.parameters !== undefined ? { parameters: draft.parameters } : {}),
      };
      await driveSet.add(config);
      services.providers.register(config);
      return config.name;
    },
    async remove(name: string): Promise<boolean> {
      await driveSet.remove(name);
      return services.providers.remove(name);
    },
  };
}
