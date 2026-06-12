import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { setupSkills } from '@matatbread/matbot-skills';
import path from 'node:path';
import process from 'node:process';
import { watchAndImportSkillDir } from './watcher.js';

export interface SkillsNodePluginConfig {
  skillsDir: string;
  pollMs?:   number;
}

/**
 * The node skills plugin. It is a specialization of @matatbread/matbot-skills — "skills, plus a
 * local filesystem watch" — so it hard-depends on the base (declared in package.json) and reuses
 * its setup directly via {@link setupSkills}, then attaches a `.md` importer/watcher to the same
 * SkillManager. One plugin, one lifecycle: no second resident plugin, no service discovery.
 */
export function createSkillsNodePlugin(config: SkillsNodePluginConfig): MatbotPluginSpec {
  let abortController: AbortController | undefined;
  let clear: (() => void) | undefined;

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      config:      ['skillsDir'],
      description: 'Node skills: embeds @matatbread/matbot-skills CRUD and adds a local filesystem (.md) import + watch.',
    },

    async installationMessage() {
      return 'Skills are active (skill_action / skill_triggers, plus a local .md import + watch). ' +
        'Their `agent`/`user` triggers are evaluated by an LLM classifier, which needs a provider ' +
        'named "skills-classifier" — until one is configured, triggers simply never fire (skills ' +
        'still work when loaded by name). Add it with the `provider` tool, pointing it at a small, ' +
        'fast model. Offer to do this now.';
    },

    async setup(services) {
      const manager = await setupSkills(services);
      clear = () => manager.clear();

      abortController = new AbortController();
      void watchAndImportSkillDir(config.skillsDir, manager, abortController.signal, config.pollMs);
    },

    async teardown() {
      abortController?.abort();
      clear?.();
    },
  };
}

export const plugin: MatbotPluginSpec = createSkillsNodePlugin({
  skillsDir: path.join(process.cwd(), '.data', 'skills'),
});
