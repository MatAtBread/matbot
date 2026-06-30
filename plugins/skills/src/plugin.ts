import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, Store } from '@matatbread/matbot-plugin-api';
import { SkillManagerImpl, type SkillManager } from './manager.js';
import { createSkillTool, createSkillsConfigTool } from './tools.js';
import type { SkillDoc } from './types.js';

/** One-shot reachability probe for a pinned provider, used only when forming installationMessage
 *  (install/reload) — never on the hot path. Fails soft: a thrown error becomes `{ ok: false }`. */
async function testProvider(services: MatbotMachine, provider: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await services.singleTurn({ provider, prompt: 'Reply with "ok".', signal: AbortSignal.timeout(15000) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** The live skill set. Registered by setupSkills; consumed by plugins that ship built-in
     *  skills (e.g. cognition). Its presence is also the "skills already wired this process" signal. */
    SkillManager?: SkillManager;
  }
}

/**
 * Shared wiring: build the {@link SkillManager}, load persisted skills, register the `skill_action`
 * (content CRUD) and `skills_config` tools, and install the always-on skills catalogue — a
 * SystemContextContributor that injects each skill's `catalogSummary` (when set) as a one-line entry
 * so the model knows the skill exists and can load it on demand.
 *
 * Skills no longer evaluate conditions or fire themselves: that is the triggers subsystem's job
 * (@matatbread/matbot-triggers), reached by a trigger whose `invoke` is `skill_action(use)`.
 *
 * Returns the manager so a specialization (e.g. the node plugin) can attach a filesystem watch.
 * Uses only web-platform APIs.
 */
export async function setupSkills(services: MatbotMachine): Promise<SkillManager> {
  // Idempotency keyed on the registered service entry, not a module-scoped flag: a re-import would
  // reset such a flag, but the registry persists across this process. So a second setupSkills (base
  // + node both configured, or any re-entry) is a benign no-op that hands back the live manager.
  if (services.SkillManager) return services.SkillManager;

  const store = services.createStore<SkillDoc>('skills') as Store<SkillDoc>;
  const manager = new SkillManagerImpl(store, services);
  await manager.load();
  // Re-read after a deferred StorageBackend swap lands: the new backend's `skills` namespace replaces
  // the old in-memory set (and re-indexes). No `replay` — the initial load is the boot load above; this
  // reacts only to future swaps. Ends with the manager (teardown aborts manager.signal).
  services.mounted.consume({ key: 'StorageBackend', signal: manager.signal }, () => void manager.load());
  await services.register('SkillManager', manager);

  services.tools.register(createSkillTool(manager));
  services.tools.register(createSkillsConfigTool(services));

  // Always-injected skills catalogue. Tiny (only skills explicitly flagged `catalogue` appear), so it
  // is a stable system-prompt prefix rather than the whole catalogue. Rebuilt each turn, so it reflects
  // live add/remove. No LLM, no condition — pure advertisement. The advertised text is the skill's
  // `catalogSummary` (a hand-written override, when set) else its generated `knowledge.summary`; a
  // flagged skill with neither yet (analysis still pending) is simply skipped until it has one.
  services.systemContext.register(() => {
    const lines = manager.all()
      .filter(s => s.catalogue === true && !s.hidden)
      .map(s => ({ name: s.name, summary: (s.catalogSummary?.trim() || s.knowledge?.summary?.trim() || '') }))
      .filter(s => s.summary !== '')
      .map(s => `- ${s.name}: ${s.summary}`);
    return lines.length === 0
      ? null
      : 'Available skills — apply the relevant one with the skill_action tool (action "use") when its ' +
        'description applies:\n' + lines.join('\n');
  });

  return manager;
}

/**
 * The cross-runtime base skills plugin: content CRUD via `skill_action`, persisted through the active
 * storage backend and indexed into the knowledge subsystem, plus a `skills_config` tool. Runs in both
 * Node and the browser. It has no filesystem watch — that lives in @matatbread/matbot-skills-node.
 */
export function createSkillsPlugin(): MatbotPluginSpec {
  let manager:  SkillManager   | undefined;
  let captured: MatbotMachine | undefined;   // captured in setup() so installationMessage() can probe

  const base =
    'Skills are active (skill_action). A skill is loaded on demand by name; to make one apply ' +
    'automatically on a behavioural condition, add a trigger (trigger_action) whose invoke is ' +
    'skill_action with { action: "use", name } — install @matatbread/matbot-triggers for that.';

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Skills (named markdown playbooks) with content CRUD via skill_action, persisted and knowledge-indexed. Cross-runtime (node + browser).',
    },

    async installationMessage() {
      if (!captured) return base;
      const pinned    = await captured.settings().get<string>('analysisProvider');
      const available = [...captured.providers.keys()];
      if (pinned === undefined) {
        return base +
          `\n\nSkill content analysis (summary/entities/tags for search) will use "${available[0] ?? '(no provider configured)'}" — ` +
          'the first configured provider. To pin a small/fast model instead, use the skills_config tool ' +
          `(action "set"). Available providers: ${available.join(', ') || '(none)'}.`;
      }
      const probe = await testProvider(captured, pinned);
      return base +
        `\n\nSkill content analysis is pinned to "${pinned}" (skills_config), which ` +
        (probe.ok
          ? 'responded to a test prompt.'
          : `did NOT respond: ${probe.error}. It falls back to the first configured provider until fixed.`);
    },

    async setup(services) {
      captured = services;
      manager  = await setupSkills(services);
    },

    async teardown() {
      manager?.clear();
    },
  };
}

export const plugin: MatbotPluginSpec = createSkillsPlugin();
