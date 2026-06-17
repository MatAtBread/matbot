import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { COGNITION_SKILLS } from './skills.js';
import { defineStore } from '@matatbread/matbot-tool-store';
import { createDreamTimeTool } from './dream/tool.js';
// These type imports also bring the `SkillManager` / `Triggers` augmentations of MatbotServices into
// cognition's compilation, since cognition is a consumer of both capabilities (discovered, not owned).
import type { SkillManager } from '@matatbread/matbot-skills';
import type { Triggers } from '@matatbread/matbot-triggers';

async function seedCognition(services: MatbotServices): Promise<void> {
  const skills: SkillManager | undefined = services.SkillManager;
  if (!skills) return;
  // Triggers are seeded separately, now that they are no longer embedded in the skill. A built-in
  // skill's `triggers` become one Trigger whose invoke loads that skill via `skill_action(load)`.
  // Both imports are create-if-absent, so an install that already holds them keeps its own copy.
  const triggers: Triggers | undefined = services.Triggers;
  for (const skill of COGNITION_SKILLS) {
    await skills.importIfAbsent(skill.name, skill.content);
    if (triggers && skill.triggers.length > 0) {
      await triggers.importIfAbsent({
        conditions: skill.triggers.map(t => ({ phase: t.phase, rule: t.trigger })),
        invoke:     { tool: 'skill_action', params: { action: 'load', name: skill.name } },
      });
    }
  }
}

async function seedDreamRunsStore(services: MatbotServices): Promise<void> {
  console.warn('[cognition] MARKER-B: seedDreamRunsStore called');
  // The `dream_runs` store backs the `dream_time` tool's observability story: every pass writes a
  // structured record here (outcome, primary fact, routed-to skill, contradictions, timings) so
  // "what did dream-time do, and why" is queryable rather than having to be parsed out of stdout.
  // Idempotent — a re-seed on restart preserves the existing run history.
  await defineStore(services, {
    namespace:   'dream_runs',
    description:
      'Records one row per `dream_time` consolidation pass: which fact was processed, which ' +
      'skill it was routed into (if any), what was merged, any contradictions flagged, and ' +
      'per-call telemetry. Queryable for "how is dream-time behaving over time" reporting.',
    shape:
      `interface DreamRun {
        id:                  string;
        version:             string;
        startedAt:           string;
        endedAt:             string;
        outcome:             'no-facts' | 'no-match' | 'merged' | 'error';
        primaryFact?:        { id: string; preview: string };
        routedTo?:           { skill: string; decision: 'strong'|'weak'|'none'; score: number; reasoning: string };
        mergedFactIds:       string[];
        contradictions:      { skill: string; location: string; note: string }[];
        unassignedRemaining: number;
        judgementCalls:      { role: 'rank'|'merge'; inputSize: number; ms: number }[];
        error?:              string;
      }`,
  });
}

/**
 * Cognitive services. Today it seeds its built-in skills (Inner voice, Remember this, Dream time)
 * into the active skills service; it is the intended home for further cognitive skills and tools.
 *
 * It does not set skills up itself — it is a *consumer* of the skills capability, not a
 * specialization of it — so it discovers the live {@link SkillManager} off the registry rather than
 * taking a runtime dependency on a specific provider. Any skills provider satisfies it
 * (@matatbread/matbot-skills, …-node, a future backend).
 *
 * Absence of a skills service is handled gracefully rather than fatally: seeding needs the live
 * manager, which a registry consumer can't guarantee is present at its own setup (config/load order
 * is not ours to dictate). So when it is already present we seed immediately; when it is not, we
 * install a one-shot `screen` hook that seeds on the first turn where it appears, then removes
 * itself. This makes seeding order-independent and self-healing (a skills provider loaded *after*
 * cognition still gets seeded, with no reload), without leaving a per-turn hook resident once the
 * one-time job is done. Throwing in setup() was the alternative, but it rolls the plugin back — a
 * later skills load would then require re-adding and reloading cognition.
 *
 * The inner-voice provider the Inner voice skill references is likewise not required: without it the
 * skill still fires, and its single_turn call simply errors back to the model at use time.
 */
export function createCognitionPlugin(): MatbotPluginSpec {
  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Cognitive services: seeds built-in cognition skills (Inner voice, Remember this, Dream time) and is the home for further cognitive skills and tools.',
    },

    async installationMessage() {
      console.warn('[cognition] MARKER-F: installationMessage() called (NEW build)');
      return `Cognition is active. It seeds built-in skills (Inner voice, Remember this, Dream time)
into the skills service — if no skills service is configured yet, they are seeded automatically once
one is.

The **Inner voice skill** consults a second, model via the single_turn tool, which needs a provider named "inner-voice";
until one is configured the skill still fires but its single_turn call errors back with no critique. Add it with the
\`provider\` tool, choosing a model from a different training lineage than your main one. Offer to do this now.

The **Remember this skill** fires when new information is provided and uses a remembered_facts store and its \`remembered_facts_action\` tool to capture user-provided facts,
personal details, preferences, and other information the user wants remembered across conversations. Each fact is captured with
provenance showing which session and message it came from.

The **\`dream_time\` tool** runs one pass of background memory consolidation. It is a deterministic
TypeScript pipeline: it picks the oldest unassigned fact from the remembered_facts store, scores it against
every existing skill via two narrow LLM judgement calls (rank and merge) using the active provider, and —
if a skill clears the configured threshold — splices the fact in and marks it processed (a \`dreamSkill\`
field). Each pass writes a structured \`DreamRun\` record to the \`dream_runs\` store. Intended to be
invoked via the \`background\` tool on a schedule, never inline. One pass at a time is enforced by a
process-local mutex.

It also seeds a remembered_facts store and its \`remembered_facts_action\` tool, used by the Remember this skill.
The store is idempotent: a re-seed on restart keeps the existing data.
`;
    },

    async setup(services) {
      console.warn('[cognition] MARKER-C: setup() entered (NEW dream-time build)');
      // Seed the remembered_facts store and its `remembered_facts_action` tool (used by the
      // Remember this skill). Idempotent — a re-seed on restart keeps the existing store's data.
      await defineStore(services, {
        namespace:   'remembered_facts',
        description:
          'Stores user-provided facts, personal details, preferences, and other information the ' +
          'user wants remembered across conversations. Each fact is captured with provenance ' +
          'showing which session and message it came from.',
        shape:
          `interface RememberedFact {
            fact: string;
            sessionId: string;
            messageId: string;
            createdAt: string;
            dreamSkill?: string;
          }`,
      });

      // Seed the dream_runs store (used by the dream_time tool) alongside remembered_facts.
      // Both stores are seeded unconditionally — they don't require a SkillManager to exist.
      await seedDreamRunsStore(services);
      console.warn('[cognition] MARKER-D: about to register dream_time tool');

      // Register the dream_time tool. It doesn't need SkillManager at REGISTRATION time (it looks
      // it up per-call), so we register it unconditionally too — the tool surfaces in catalogues
      // immediately, and if a SkillManager isn't present at invocation it errors cleanly.
      services.tools.register(createDreamTimeTool(services));
      console.warn('[cognition] MARKER-E: dream_time tool registered OK');

      if (services.SkillManager) {
        await seedCognition(services);
        return;
      }

      // No skills service yet — defer. Seed on the first turn it appears, then unregister this hook.
      // (Triggers are seeded opportunistically in the same pass: if the Triggers service is present
      // by then it gets the load-triggers too, otherwise the skills still seed without them.)
      console.warn(
        '[cognition] No skills service present at setup; built-in skills will be seeded on the first ' +
        'turn after a skills service (e.g. @matatbread/matbot-skills) is loaded.',
      );
      let seeded = false;
      services.hooks.register({
        on: 'screen',
        async handler(ctx) {
          if (seeded || !services.SkillManager) return;
          seeded = true;
          await seedCognition(services);
          ctx.removeHook();
        },
      });
    },
  };
}

export const plugin: MatbotPluginSpec = createCognitionPlugin();
