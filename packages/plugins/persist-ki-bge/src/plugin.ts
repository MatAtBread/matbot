import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPlugin, KnowledgeEntry, Store } from '@matatbread/matbot-plugin-api';
import { PersistBGEKnowledgeIndex } from './knowledge-index.js';

export function createPersistKIBGEPlugin(): MatbotPlugin {
  return {
    name:       'persist-ki-bge',
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      credentials: ['SKILL_RANK_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
    },

    async setup(services) {
      const store = services.createStore<KnowledgeEntry>('knowledge') as Store<KnowledgeEntry>;
      await services.register('knowledge', new PersistBGEKnowledgeIndex(store, services.vault));
    },
  };
}

export const plugin: MatbotPlugin = createPersistKIBGEPlugin();
