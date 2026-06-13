import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotServices, Store, Message } from '@matatbread/matbot-plugin-api';
import { SkillManager } from './manager.js';
import { createSkillTool, createSkillTriggersTool, createSingleTurnTool, singleTurn } from './tools.js';
import type { SkillDoc } from './types.js';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** The live skill set. Registered by setupSkills; consumed by plugins that ship built-in
     *  skills (e.g. cognition). Its presence is also the "skills already wired this process" signal. */
    SkillManager?: SkillManager;
  }
}

const CLASSIFIER_PROVIDER = 'skills-classifier';
const MAX_MSG_CHARS = 1500;

function textOf(msg: Message | undefined): string {
  return msg?.content.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
}

function clip(text: string): string {
  if (text.length <= MAX_MSG_CHARS) return text;
  const half = Math.floor((MAX_MSG_CHARS - 3) / 2);
  return text.slice(0, half) + '...' + text.slice(-half);
}

function skillBlock(matched: SkillDoc[]): string {
  return matched.map(s => `## ${s.name}\n\n${s.content}`).join('\n\n---\n\n');
}

/**
 * LLM-judge the `agent`/`user` triggers of `phase` against the current turn and return the distinct
 * skills whose trigger fired. Both sides of the exchange are passed, clearly delineated: `subject` is
 * the message the triggers are evaluated against, and `context` is the opposing message it is paired
 * with (what `subject` responds to, or what prompted it). `context` is a first-class input, not a
 * footnote, because many triggers are relational — "the user disputes the previous answer", "the
 * assistant asserted a cause the user never asked for" — and can only be judged from the pair.
 * Makes no LLM call when there are no candidate triggers. (`system` triggers are NOT conditions —
 * they are injected as a catalogue, not evaluated here.)
 */
async function matchedSkills(
  services: MatbotServices,
  manager:  SkillManager,
  phase:    'agent' | 'user',
  subject:  { label: string; text: string },
  context:  { label: string; text: string },
  signal:   AbortSignal,
): Promise<SkillDoc[]> {
  const candidates = manager.all().flatMap(s =>
    (s.triggers ?? [])
      .filter(t => t.phase === phase && t.id !== undefined)
      .map(t => ({ skill: s.name, id: t.id as string, trigger: t.trigger })),
  );
  if (candidates.length === 0 || subject.text === '') return [];

  const res = await singleTurn(services, {
    provider: CLASSIFIER_PROVIDER,
    signal,
    system:
      'You are a trigger classifier for a conversational assistant. Below is the current exchange — ' +
      'the user message and the assistant message, in chronological order and clearly labelled — ' +
      `followed by a list of triggers. Evaluate each trigger against the "${subject.label}". The ` +
      `"${context.label}" is the message it is paired with; use it fully whenever a trigger is ` +
      'relational (refers to what was asked, answered, disputed, or repeated). Fire a trigger when, ' +
      `reading the "${subject.label}" in light of the "${context.label}", its condition holds. Return ` +
      'ONLY a JSON object mapping each trigger id (the bracketed value) to true or false. No other text.',
    prompt:
      `${context.label} (earlier):\n${context.text === '' ? '(none)' : clip(context.text)}\n\n` +
      `${subject.label} (later — evaluate the triggers against THIS):\n${clip(subject.text)}\n\n` +
      `Triggers:\n${candidates.map(c => `[${c.id}] ${c.trigger}`).join('\n')}`,
  });

  let verdicts: Record<string, unknown> = {};
  try {
    const m = res.text.match(/\{[\s\S]*\}/);
    verdicts = m ? JSON.parse(m[0]) : {};
  } catch {
    console.warn(`[skills] ${phase} classifier returned non-JSON:`, res.text.slice(0, 200));
    return [];
  }

  /* Debug
  if (Object.values(verdicts).some(v => v)) {
    console.group(`[skills] ${phase}-trigger eval`);
    for (const c of candidates) {
      if (verdicts[c.id] === true) console.log("FIRE", c.skill, c.trigger.slice(0, 60), subject, context);
    }
    console.groupEnd();
  }
  */

  const fired = candidates.filter(c => verdicts[c.id] === true);
  return [...new Set(fired.map(c => c.skill))]
    .map(name => manager.get(name))
    .filter((s): s is SkillDoc => s !== undefined && s.content.trim() !== '');
}

/**
 * Shared wiring: build the {@link SkillManager}, load persisted skills, register the `skill_action`
 * (content CRUD) and `skill_triggers` (trigger CRUD) tools, then install the three trigger phases:
 *
 *   system — a SystemContextContributor that injects every `system`-phase trigger as a one-line
 *            skills catalogue into the system prompt each turn. Not a condition; no LLM call.
 *   user   — a `screen` hook (pre-response) that LLM-judges `user`-phase conditions against the
 *            incoming user message and ephemerally injects matched skills for this turn only.
 *   agent  — a `followup` hook (post-commit) that LLM-judges `agent`-phase conditions against the
 *            assistant's response and resubmits a robo turn loading matched skills.
 *
 * Returns the manager so a specialization (e.g. the node plugin) can attach a filesystem watch.
 * Uses only web-platform APIs.
 */
export async function setupSkills(services: MatbotServices): Promise<SkillManager> {
  // Idempotency keyed on the registered service entry, not a module-scoped flag: a re-import would
  // reset such a flag, but the registry persists across this process. So a second setupSkills (base
  // + node both configured, or any re-entry) is a benign no-op that hands back the live manager —
  // letting a specialization (skills-node) attach its watcher to the same one rather than a duplicate.
  if (services.SkillManager) return services.SkillManager;

  const store = services.createStore<SkillDoc>('skills') as Store<SkillDoc>;
  const manager = new SkillManager(store, services, CLASSIFIER_PROVIDER);
  await manager.init();
  await services.register('SkillManager', manager);

  services.tools.register(createSkillTool(manager));
  services.tools.register(createSkillTriggersTool(manager));
  services.tools.register(createSingleTurnTool(services));

  // system phase — always-injected skills catalogue. Tiny (a handful of router/index skills), so it
  // is a stable system-prompt prefix rather than the whole 90-skill catalogue (the bloat this whole
  // mechanism exists to avoid). Rebuilt each turn, so it reflects live add/remove. No LLM, no gate.
  services.systemContext.register(() => {
    const lines = manager.all().flatMap(s =>
      (s.triggers ?? []).filter(t => t.phase === 'system').map(t => `- ${s.name}: ${t.trigger}`),
    );
    return lines.length === 0
      ? null
      : 'Available skills — load the relevant one with the skill_action tool (action "load") when its ' +
        'description applies:\n' + lines.join('\n');
  });

  // user phase — pre-response. Judges the incoming user message (sentiment / meta-conversational
  // signals: frustration, repetition, correction, change of direction — things search can't detect)
  // and injects matched skills EPHEMERALLY, so they inform this response without persisting.
  services.hooks.register({
    on: 'screen',
    async handler(ctx) {
      if (!services.providers.has(CLASSIFIER_PROVIDER)) return;
      const lastUser = ctx.session.messages.findLast(l => l.role === 'user');
      // Skip our own agent-phase robo injections — they are not real user turns.
      if (!lastUser || lastUser.content.every(c => c.origin === 'robo')) return;

      const matched = await matchedSkills(
        services, manager, 'user',
        { label: 'latest user message', text: textOf(lastUser) },
        { label: 'preceding assistant message', text: textOf(ctx.session.messages.findLast(
          l => l.role === 'assistant' && l.content.some(c => c.type === 'text'),
        )) },
        ctx.signal,
      );
      if (matched.length === 0) return;

      return {
        ephemeral: [{
          type: 'text',
          text: 'The following skill(s) are relevant to the user\'s latest message — apply them in ' +
            'your response:\n\n' + skillBlock(matched),
        }],
      };
    },
  });

  // agent phase — post-commit. The triggers are evaluated against the assistant's response (so they
  // fire on the response, not the user's words), with the preceding user message as relational
  // context (e.g. "asserted a cause the user never asked for"). Loads matched skills via a robo resubmit.
  services.hooks.register({
    on: 'followup',
    async handler(ctx) {
      // Don't react to our own injections: a fired trigger resubmits a robo turn that loads the
      // matched skill, and evaluating that turn could re-load in a loop. (The runner also hard-caps
      // resubmitDepth; skipping robo turns avoids the wasted re-evaluation entirely.)
      if (ctx.resubmitDepth > 0) return;
      if (!services.providers.has(CLASSIFIER_PROVIDER)) return;

      const matched = await matchedSkills(
        services, manager, 'agent',
        { label: 'assistant response', text: textOf(ctx.session.messages.findLast(
          l => l.role === 'assistant' && l.content.some(c => c.type === 'text'),
        )) },
        { label: 'preceding user message', text: textOf(ctx.session.messages.findLast(l => l.role === 'user')) },
        ctx.signal,
      );
      if (matched.length === 0) return;

      // Name the matched skills and let the model pull them via skill_action — don't inline content.
      // This is a resubmit, so it commits to history; inlining the full playbook(s) every fire is
      // expensive and permanent, and pointless when the content is often already upthread. The model
      // loads only what it doesn't already hold in context (or skips the load entirely).
      const names = matched.map(s => s.name).join(', ');
      return {
        resubmit: {
          content: [{
            type:   'text',
            origin: 'robo',
            text:   `Use the skill${names.length>1 ? 's':''}: ${names}`,
          }],
        },
      };
    },
  });

  return manager;
}

/**
 * The cross-runtime base skills plugin: content CRUD via `skill_action`, trigger CRUD via
 * `skill_triggers`, persisted through the active storage backend and indexed into the knowledge
 * subsystem. Runs in both Node and the browser. It has no filesystem watch — that lives in
 * @matatbread/matbot-skills-node.
 */
export function createSkillsPlugin(): MatbotPluginSpec {
  let manager: SkillManager | undefined;

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest: {
      description: 'Skills (named markdown playbooks) with content CRUD via skill_action and trigger CRUD via skill_triggers. Cross-runtime (node + browser).',
    },

    async installationMessage() {
      return 'Skills are active (skill_action / skill_triggers). Their `agent`/`user` triggers are ' +
        'evaluated by an LLM classifier, which needs a provider named "skills-classifier" — until ' +
        'one is configured, triggers simply never fire (skills still work when loaded by name). ' +
        'Add it with the `provider` tool, pointing it at a small, fast model. Offer to do this now.';
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
