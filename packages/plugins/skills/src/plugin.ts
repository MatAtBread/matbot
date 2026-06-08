import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotServices, Store } from '@matatbread/matbot-plugin-api';
import { SkillManager } from './manager.js';
import { createSkillTool } from './tools.js';
import type { SkillDoc } from './types.js';
// import { createSkillIndexHook, createUserMessageClassifierHook, createAgentMessageClassifierHook } from './hooks.js';

/**
 * Shared wiring: build the {@link SkillManager}, load persisted skills, and register the
 * `skill_action` CRUD tool. Returns the manager so a specialization (e.g. the node plugin)
 * can attach a filesystem watch on top of the same instance. Uses only web-platform APIs.
 */
export async function setupSkills(services: MatbotServices): Promise<SkillManager> {
  const store   = services.createStore<SkillDoc>('skills') as Store<SkillDoc>;
  const manager = new SkillManager(store, services.knowledge);
  await manager.init();

  services.tools.register(createSkillTool(manager));

  // const getSkills       = (): SkillDoc[] => manager.all();
  // const pluginSettings  = services.settings();
  // services.hooks.register(createUserMessageClassifierHook(pluginSettings, services.providers, getSkills));
  // services.hooks.register(createSkillIndexHook(getSkills));
  // services.hooks.register(createAgentMessageClassifierHook(getSkills, pluginSettings, req => services.complete(req)));

  return manager;
}

/**
 * The cross-runtime base skills plugin: CRUD over skills via `skill_action`, persisted through
 * the active storage backend and indexed into the knowledge subsystem. Runs in both Node and the
 * browser. It has no filesystem watch — that lives in @matatbread/matbot-skills-node.
 */
export function createSkillsPlugin(): MatbotPluginSpec {
  let manager: SkillManager | undefined;

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Skill documents (named markdown playbooks) with CRUD via skill_action. Cross-runtime (node + browser).',
    },

    async setup(services) {
      manager = await setupSkills(services);
    },

    async teardown() {
      manager?.clear();
    },
  };
}

export const plugin: MatbotPluginSpec = createSkillsPlugin();
