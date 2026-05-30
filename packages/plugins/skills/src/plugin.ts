import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPlugin, Store } from '@matatbread/matbot-plugin-api';
import path from 'node:path';
import process from 'node:process';
import { createSkillIndexHook, createClassifierSetupHook, createSkillClassifierHook } from './hooks.js';
import type { SkillDoc } from './types.js';
import { watchAndImportSkillDir } from './watcher.js';
import { createSkillTools } from './tools.js';

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

      // Pre-populate in-memory map from the store.
      const { items } = await store.query({});
      for (const { doc } of items) skills.set(doc.name.toLowerCase(), doc);

      // Register tools dynamically (skillsDir not available at module eval time).
      for (const tool of createSkillTools(store, skills)) {
        services.tools.register(tool);
      }

      // Import any .md files from the skills directory into the store.
      abortController = new AbortController();
      void watchAndImportSkillDir(config.skillsDir, store, skills, abortController.signal, config.pollMs);

      const getSkills = (): SkillDoc[] => [...skills.values()];
      const pluginSettings = services.settings('skills');
      services.hooks.register(createClassifierSetupHook(pluginSettings, services.providers, getSkills));
      // services.hooks.register(createSkillIndexHook(getSkills));
      services.hooks.register(createSkillClassifierHook(getSkills, pluginSettings, req => services.complete(req)));
    },

    async teardown() {
      abortController?.abort();
      skills.clear();
    },
  };
}

// ── Default plugin export ─────────────────────────────────────────────────────

export const plugin: MatbotPlugin = (() => {
  let inner: MatbotPlugin | undefined;

  return {
    name:       'skills',
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Skill documents injected into sessions on demand.',
      config:      ['skillsDir'],
    },

    async setup(services) {
      const extCfg = (services.extensions?.['skills'] as Record<string, unknown> | undefined) ?? {};
      const rawDir = extCfg['skillsDir'];
      const skillsDir = typeof rawDir === 'string'
        ? rawDir
        : path.join(process.cwd(), '.data', 'skills');

      inner = createSkillsPlugin({ skillsDir });
      await inner.setup?.(services);
    },

    async teardown() {
      await inner?.teardown?.();
    },
  };
})();
