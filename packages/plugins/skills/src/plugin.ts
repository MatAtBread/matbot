import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotServices, Store } from '@matatbread/matbot-plugin-api';
import { SkillManager } from './manager.js';
import { createSkillTool, createSingleTurnTool } from './tools.js';
import type { SkillDoc } from './types.js';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** The live skill set. Registered by setupSkills; consumed by plugins that ship built-in
     *  skills (e.g. cognition). Its presence is also the "skills already wired this process" signal. */
    SkillManager?: SkillManager;
  }
}

// The provider name used to derive a skill's catalogue summary / knowledge analysis when one isn't
// cached. Kept distinct from any trigger-classifier provider — skills no longer evaluate conditions.
const ANALYSIS_PROVIDER = 'skills-classifier';

/**
 * Shared wiring: build the {@link SkillManager}, load persisted skills, register the `skill_action`
 * (content CRUD) and `single_turn` tools, and install the always-on skills catalogue — a
 * SystemContextContributor that injects each skill's `catalogSummary` (when set) as a one-line entry
 * so the model knows the skill exists and can load it on demand.
 *
 * Skills no longer evaluate conditions or fire themselves: that is the triggers subsystem's job
 * (@matatbread/matbot-triggers), reached by a trigger whose `invoke` is `skill_action(use)`.
 *
 * Returns the manager so a specialization (e.g. the node plugin) can attach a filesystem watch.
 * Uses only web-platform APIs.
 */
export async function setupSkills(services: MatbotServices): Promise<SkillManager> {
  // Idempotency keyed on the registered service entry, not a module-scoped flag: a re-import would
  // reset such a flag, but the registry persists across this process. So a second setupSkills (base
  // + node both configured, or any re-entry) is a benign no-op that hands back the live manager.
  if (services.SkillManager) return services.SkillManager;

  const store = services.createStore<SkillDoc>('skills') as Store<SkillDoc>;
  const manager = new SkillManager(store, services, ANALYSIS_PROVIDER);
  await manager.init();
  await services.register('SkillManager', manager);

  services.tools.register(createSkillTool(manager));
  services.tools.register(createSingleTurnTool(services));

  // Always-injected skills catalogue. Tiny (a handful of router/index skills carry a catalogSummary),
  // so it is a stable system-prompt prefix rather than the whole catalogue. Rebuilt each turn, so it
  // reflects live add/remove. No LLM, no condition — pure advertisement.
  services.systemContext.register(() => {
    const lines = manager.all()
      .filter(s => s.catalogSummary !== undefined && s.catalogSummary.trim() !== '')
      .map(s => `- ${s.name}: ${s.catalogSummary}`);
    return lines.length === 0
      ? null
      : 'Available skills — apply the relevant one with the skill_action tool (action "use") when its ' +
        'description applies:\n' + lines.join('\n');
  });

  return manager;
}

/**
 * The cross-runtime base skills plugin: content CRUD via `skill_action`, persisted through the active
 * storage backend and indexed into the knowledge subsystem, plus a `single_turn` tool. Runs in both
 * Node and the browser. It has no filesystem watch — that lives in @matatbread/matbot-skills-node.
 */
export function createSkillsPlugin(): MatbotPluginSpec {
  let manager: SkillManager | undefined;

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Skills (named markdown playbooks) with content CRUD via skill_action, persisted and knowledge-indexed. Cross-runtime (node + browser).',
    },

    async installationMessage() {
      return 'Skills are active (skill_action). A skill is loaded on demand by name; to make one apply ' +
        'automatically on a behavioural condition, add a trigger (trigger_action) whose invoke is ' +
        'skill_action with { action: "use", name } — install @matatbread/matbot-triggers for that.';
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
