import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPlugin, KnowledgeEntry, Store } from '@matatbread/matbot-plugin-api';
import { PersistBGEKnowledgeIndex } from './knowledge-index.js';

export function createPersistKIBGEPlugin(): MatbotPlugin {
  return {
    name:       'persist-ki-bge',
    apiVersion: PLUGIN_API_VERSION,

    async setup(services) {
      const store = services.createStore<KnowledgeEntry>('knowledge') as Store<KnowledgeEntry>;
      await services.register('knowledge', new PersistBGEKnowledgeIndex(store, services.vault));
    },
  };
}

export const plugin: MatbotPlugin = createPersistKIBGEPlugin();
