export type * from '@matatbread/matbot-plugin-api';

// ── Internal types (not part of the plugin API) ───────────────────────────────

import type {
  ProviderAdapter,
} from '@matatbread/matbot-plugin-api';

export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  resolve(name: string): ProviderAdapter;
}

