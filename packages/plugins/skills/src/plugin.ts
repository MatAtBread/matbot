import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPlugin, Store } from '@matatbread/matbot-plugin-api';
import path from 'node:path';
import process from 'node:process';
import { createSkillIndexHook, createUserMessageClassifierHook, createAgentMessageClassifierHook } from './hooks.js';
import type { SkillDoc } from './types.js';
import { watchAndImportSkillDir } from './watcher.js';
import { createSkillTools, skillToKnowledgeEntry } from './tools.js';

export interface SkillsPluginConfig {
  skillsDir: string;
  pollMs?:   number;
}

export function createSkillsPlugin(config: SkillsPluginConfig): MatbotPlugin {
  const skills = new Map<string, SkillDoc>();
  let abortController: AbortController | undefined;

  return {
    name:       'skills',
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Skill documents injected into sessions on demand.',
      config:      ['skillsDir'],
    },

    async setup(services) {
      const store = services.createStore<SkillDoc>('skills') as Store<SkillDoc>;

      // Pre-populate in-memory map from the store and index all existing skills.
      const { items } = await store.query({});
      for (const { doc } of items) {
        skills.set(doc.name.toLowerCase(), doc);
        void services.knowledge.index(skillToKnowledgeEntry(doc));
      }

      // Register tools dynamically (skillsDir not available at module eval time).
      for (const tool of createSkillTools(store, skills, services.knowledge)) {
        services.tools.register(tool);
      }

      // Import any .md files from the skills directory into the store.
      abortController = new AbortController();
      void watchAndImportSkillDir(config.skillsDir, store, skills, abortController.signal, config.pollMs);

      const getSkills = (): SkillDoc[] => [...skills.values()];
      const pluginSettings = services.settings('skills');
      // services.hooks.register(createUserMessageClassifierHook(pluginSettings, services.providers, getSkills));
      // services.hooks.register(createSkillIndexHook(getSkills));
      // services.hooks.register(createAgentMessageClassifierHook(getSkills, pluginSettings, req => services.complete(req)));
    },

    async teardown() {
      abortController?.abort();
      skills.clear();
    },
  };
}

// ── Default plugin export ─────────────────────────────────────────────────────

export const plugin: MatbotPlugin = createSkillsPlugin({
  skillsDir: path.join(process.cwd(), '.data', 'skills'),
});
