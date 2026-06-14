import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { COGNITION_SKILLS } from './skills.js';
import { defineStore } from '@matatbread/matbot-tool-store';

async function seedSkills(skills: NonNullable<MatbotServices['SkillManager']>): Promise<void> {
  // Create-if-absent: an install that already holds a skill of the same name keeps its own copy.
  for (const skill of COGNITION_SKILLS) {
    await skills.importIfAbsent(skill.name, skill.content, skill.triggers);
  }
}

/**
 * Cognitive services. Today it seeds its built-in skills (Inner voice, Remember this) into the
 * active skills service; it is the intended home for further cognitive skills and tools.
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
      description: 'Cognitive services: seeds built-in cognition skills (Inner voice, Remember this) and is the home for further cognitive skills and tools.',
    },

    async installationMessage() {
      return `Cognition is active. It seeds built-in skills (Inner voice, Remember this) into the
skills service — if no skills service is configured yet, they are seeded automatically once
one is.

The **Inner voice skill** consults a second, model via the single_turn tool, which needs a provider named "inner-voice";
until one is configured the skill still fires but its single_turn call errors back with no critique. Add it with the
\`provider\` tool, choosing a model from a different training lineage than your main one. Offer to do this now.

The **Remember this skill** fires when new information is provided and uses a remembered_facts store and its \`remembered_facts_action\` tool to capture user-provided facts,
personal details, preferences, and other information the user wants remembered across conversations. Each fact is captured with
provenance showing which session and message it came from.

It also seeds a remembered_facts store and its \`remembered_facts_action\` tool, used by the Remember this skill.
The store is idempotent: a re-seed on restart keeps the existing data.
`;
    },

    async setup(services) {
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

      if (services.SkillManager) {
        await seedSkills(services.SkillManager);
        return;
      }

      // No skills service yet — defer. Seed on the first turn it appears, then unregister this hook.
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
          await seedSkills(services.SkillManager);
          ctx.removeHook();
        },
      });
    },
  };
}

export const plugin: MatbotPluginSpec = createCognitionPlugin();
