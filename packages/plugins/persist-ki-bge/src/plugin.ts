import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, KnowledgeEntry, Store } from '@matatbread/matbot-plugin-api';
import { PersistBGEKnowledgeIndex } from './knowledge-index.js';

export function createPersistKIBGEPlugin(): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,

    async installationMessage() {
      return 'Persistent knowledge index is active. It can optionally use a Cloudflare ' +
        'BGE reranker for sharper semantic search; without it, search falls back to ' +
        'entity- and heading-based scoring. To enable the reranker, store two secrets ' +
        'with the `plugin` tool (action "store-key"): CLOUDFLARE_ACCOUNT_ID and ' +
        'SKILL_RANK_API_KEY. Offer to do this now, but it is optional.';
    },

    async setup(services) {
      const store = services.createStore<KnowledgeEntry>('knowledge') as Store<KnowledgeEntry>;
      await services.register('KnowledgeIndex', new PersistBGEKnowledgeIndex(store, services.vault));
    },
  };
}

export const plugin: MatbotPluginSpec = createPersistKIBGEPlugin();
