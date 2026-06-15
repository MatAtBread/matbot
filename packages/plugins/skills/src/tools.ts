import type { Tool, ToolExecutor, ToolContext, ToolEvent, MatbotServices } from '@matatbread/matbot-plugin-api';
import type { SkillManager } from './manager.js';
import type { TriggerPhase } from './types.js';

const PHASES: readonly TriggerPhase[] = ['agent', 'user', 'system'];
const isPhase = (x: unknown): x is TriggerPhase => typeof x === 'string' && (PHASES as readonly string[]).includes(x);

// Shared so skill_action (where the model first decides whether to add triggers) and skill_triggers
// (where it writes them) teach the same definition and can't drift.
const TRIGGER_GUIDANCE =
  "A trigger's meaning depends on its `phase`:\n" +
  '• agent / user — a CONDITION on the FORM or SENTIMENT of a message, NOT its topic (topical ' +
  'relevance is found automatically by search, so keyword/entity conditions like "France" or "RTA" ' +
  'are redundant noise; do NOT create them, and do NOT split one condition into many fragments). ' +
  'Write it as a single LLM-judged rubric "MATCH if the message is …; DO NOT MATCH if the message ' +
  'is …", judged against the current turn. `agent` tests the ASSISTANT RESPONSE (e.g. it stated a ' +
  'cause as fact without verifying it); `user` tests the USER MESSAGE (e.g. frustration, repetition, ' +
  'correction, a change of direction).\n' +
  '• system — NOT a condition. A one-line SUMMARY of what the skill is for and when to load it, ' +
  'always injected into a top-level skills catalogue so the model knows the skill exists and reaches ' +
  'for it (e.g. "Load before any data-source skill for questions about traffic, page views, ' +
  'referrers, revenue, …"). Use for always-available router/index skills.';

// The precise per-action contract. JSON Schema can't express "content required only for save"
// without an awkward oneOf, so the schema stays loose and the description carries this TypeScript
// discriminated union — which LLMs read accurately — as the source of truth. The executor enforces it.
type SkillInput =
  | { action: 'list' }
  | { action: 'load';     name: string }
  | { action: 'metadata'; name: string }
  | { action: 'save';     name: string; content: string }
  | { action: 'delete';   name: string };

export function createSkillTool(manager: SkillManager): Tool {
  const executor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args = input as Partial<SkillInput> & { action?: string };

      switch (args.action) {
        case 'list': {
          yield { type: 'result', value: { skills: manager.list() } };
          return;
        }

        case 'load': {
          const { name } = args as Extract<SkillInput, { action: 'load' }>;
          if (!name) { yield { type: 'error', message: 'action "load" requires "name".' }; return; }
          const doc = manager.get(name);
          if (!doc) { yield { type: 'error', message: `Skill not found: "${name}"` }; return; }
          yield { type: 'result', value: { id: doc.id, name: doc.name, content: doc.content } };
          return;
        }

        case 'metadata': {
          const { name } = args as Extract<SkillInput, { action: 'metadata' }>;
          if (!name) { yield { type: 'error', message: 'action "metadata" requires "name".' }; return; }
          const doc = manager.get(name);
          if (!doc) { yield { type: 'error', message: `Skill not found: "${name}"` }; return; }
          // Derived LLM analysis; absent until the background analysis has run and cached it.
          yield { type: 'result', value: { id: doc.id, name: doc.name, knowledge: doc.knowledge ?? null } };
          return;
        }

        case 'save': {
          const { name, content } = args as Extract<SkillInput, { action: 'save' }>;
          if (!name) { yield { type: 'error', message: 'action "save" requires "name".' }; return; }
          if (content === undefined) { yield { type: 'error', message: 'action "save" requires "content".' }; return; }
          const doc = await manager.save(name, content);
          yield { type: 'result', value: { id: doc.id, name: doc.name } };
          return;
        }

        case 'delete': {
          const { name } = args as Extract<SkillInput, { action: 'delete' }>;
          if (!name) { yield { type: 'error', message: 'action "delete" requires "name".' }; return; }
          const doc = await manager.delete(name);
          if (doc === undefined) { yield { type: 'error', message: `Skill not found: "${name}"` }; return; }
          yield { type: 'result', value: { id: doc.id, name: doc.name } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: list, load, save, delete.` };
      }
    },
  };

  return {
    name: 'skill_action',
    description:
      'Manage skills — named, reusable markdown playbooks (procedures, conventions, reference ' +
      'notes) the assistant stores and recalls on demand. A skill is keyed by name (case-insensitive) ' +
      'and holds markdown content. Use this tool to list skills, load one (its content, for use), ' +
      'read its derived metadata (summary/entities/tags), create or update one, or delete one.\n\n' +
      'A skill\'s triggers (the conditions for when it fires) are created and edited ONLY via the ' +
      'skill_triggers tool — never here — and are deliberately NOT returned by load. Most skills need ' +
      'NO triggers (search surfaces them by content); add one only for a genuine behavioural condition. ' +
      TRIGGER_GUIDANCE + '\n\n' +
      'Parameters depend on `action` (TypeScript):\n' +
      '```ts\n' +
      'type SkillAction =\n' +
      "  | { action: 'list' }                            // -> { skills: [{ id, name, toolBinding? }] }\n" +
      "  | { action: 'load';     name: string }          // -> { id, name, content }\n" +
      "  | { action: 'metadata'; name: string }          // derived analysis -> { id, name, knowledge: { summary, entities, tags } | null }\n" +
      "  | { action: 'save';     name: string; content: string }  // create or update -> { id, name }\n" +
      "  | { action: 'delete';   name: string };         // -> { id, name }\n" +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:   { type: 'string', enum: ['list', 'load', 'metadata', 'save', 'delete'], description: 'The operation to perform.' },
        name:     { type: 'string', description: 'Skill name (case-insensitive). Required for load/save/delete.' },
        content:  { type: 'string', description: 'Skill content in markdown — required for action "save".' },
      },
    },
    executor,
  };
}

type SkillTriggersInput =
  | { action: 'get';    name: string }
  | { action: 'add';    name: string; phase: TriggerPhase; trigger: string }
  | { action: 'update'; name: string; id: string; trigger?: string; phase?: TriggerPhase }
  | { action: 'remove'; name: string; id: string };

/**
 * Trigger CRUD, separate from skill_action because triggers are addressed individually by a stable
 * `id` and the verbs differ. Flat scalar params (name/id/phase/trigger) map directly onto an HTTP
 * form's fields and onto an LLM's id-targeted edit; identity is always the id, never the text.
 */
export function createSkillTriggersTool(manager: SkillManager): Tool {
  const executor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args = input as Partial<SkillTriggersInput> & { action?: string; name?: string; id?: string; phase?: string; trigger?: string };

      if (!args.name) { yield { type: 'error', message: 'skill_triggers requires "name".' }; return; }

      switch (args.action) {
        case 'get': {
          const doc = manager.get(args.name);
          if (!doc) { yield { type: 'error', message: `Skill not found: "${args.name}"` }; return; }
          yield { type: 'result', value: { skillId: doc.id, name: doc.name, triggers: doc.triggers ?? [] } };
          return;
        }

        case 'add': {
          if (!isPhase(args.phase)) { yield { type: 'error', message: `action "add" requires "phase" — one of: ${PHASES.join(', ')}.` }; return; }
          if (typeof args.trigger !== 'string') { yield { type: 'error', message: 'action "add" requires a string "trigger".' }; return; }
          const r = await manager.addTrigger(args.name, args.phase, args.trigger);
          if (!r) { yield { type: 'error', message: `Skill not found: "${args.name}"` }; return; }
          yield { type: 'result', value: { skillId: r.doc.id, name: r.doc.name, id: r.id } };
          return;
        }

        case 'update': {
          if (!args.id) { yield { type: 'error', message: 'action "update" requires the trigger "id".' }; return; }
          if (args.phase !== undefined && !isPhase(args.phase)) { yield { type: 'error', message: `"phase" must be one of: ${PHASES.join(', ')}.` }; return; }
          if (args.trigger !== undefined && typeof args.trigger !== 'string') { yield { type: 'error', message: '"trigger" must be a string.' }; return; }
          const patch = {
            ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
            ...(args.phase   !== undefined ? { phase: args.phase }     : {}),
          };
          const r = await manager.updateTrigger(args.name, args.id, patch);
          if (r === undefined)    { yield { type: 'error', message: `Skill not found: "${args.name}"` }; return; }
          if (r === 'no-trigger') { yield { type: 'error', message: `Trigger id not found on "${args.name}": "${args.id}"` }; return; }
          yield { type: 'result', value: { skillId: r.id, name: r.name, triggers: r.triggers ?? [] } };
          return;
        }

        case 'remove': {
          if (!args.id) { yield { type: 'error', message: 'action "remove" requires the trigger "id".' }; return; }
          const r = await manager.removeTrigger(args.name, args.id);
          if (r === undefined)    { yield { type: 'error', message: `Skill not found: "${args.name}"` }; return; }
          if (r === 'no-trigger') { yield { type: 'error', message: `Trigger id not found on "${args.name}": "${args.id}"` }; return; }
          yield { type: 'result', value: { skillId: r.id, name: r.name, triggers: r.triggers ?? [] } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: get, add, update, remove.` };
      }
    },
  };

  return {
    name: 'skill_triggers',
    description:
      'Read and edit the triggers of a skill.\n\n' +
      TRIGGER_GUIDANCE + '\n\nExamples:\n' +
      '  agent:  "MATCH if the agent states a cause or diagnosis as fact without a tool call to verify ' +
      'it; DO NOT MATCH if it ends by asking the user for clarification."\n' +
      '  user:   "MATCH if the user states a specific, non-general-knowledge fact worth remembering; ' +
      'DO NOT MATCH greetings, opinions without facts, or questions."\n' +
      '  system: "Load before any data-source skill for questions about traffic, page views, ' +
      'referrers, revenue, unique users, geo/platform breakdowns, or analytics depending on site traffic."\n\n' +
      'A trigger has a stable `id` — address it by that, never by its text. To change one, "get" first ' +
      'to read each id, then "update" by id.\n\n' +
      'Parameters depend on `action` (TypeScript):\n' +
      '```ts\n' +
      "type TriggerPhase = 'agent' | 'user' | 'system';\n" +
      'type SkillTriggersAction =\n' +
      "  | { action: 'get';    name: string }                                          // -> { skillId, name, triggers: [{ id, phase, trigger }] }\n" +
      "  | { action: 'add';    name: string; phase: TriggerPhase; trigger: string }    // -> { skillId, name, id }\n" +
      "  | { action: 'update'; name: string; id: string; trigger?: string; phase?: TriggerPhase }  // edit one by id\n" +
      "  | { action: 'remove'; name: string; id: string };                             // delete one by id\n" +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['action', 'name'],
      properties: {
        action:  { type: 'string', enum: ['get', 'add', 'update', 'remove'], description: 'The operation to perform.' },
        name:    { type: 'string', description: 'Skill name (case-insensitive).' },
        id:      { type: 'string', description: 'Trigger id. Required for update/remove.' },
        phase:   { type: 'string', enum: ['agent', 'user', 'system'], description: 'Trigger phase. Required for add; optional for update.' },
        trigger: { type: 'string', description: 'Trigger text. Required for add; optional for update.' },
      },
    },
    executor,
  };
}

/**
 * Exposes {@link MatbotServices.singleTurn} to the model: a one-shot call to a SEPARATE configured provider. The
 * intended use is consulting another model (e.g. a different-lineage critic of the current draft)
 * with a well-defined interface, rather than the model improvising a bash/curl call. Lives in the
 * skills toolset for now; may move to a more general home later.
 */
export function createSingleTurnTool(services: MatbotServices): Tool {
  const executor: ToolExecutor = {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args = input as { provider?: string; prompt?: string; system?: string };
      if (!args.provider)                  { yield { type: 'error', message: 'single_turn requires "provider".' }; return; }
      if (typeof args.prompt !== 'string') { yield { type: 'error', message: 'single_turn requires a string "prompt".' }; return; }
      if (!services.providers.has(args.provider)) {
        const known = [...services.providers.keys()].join(', ') || '(none configured)';
        yield { type: 'error', message: `Unknown provider "${args.provider}". Configured providers: ${known}.` };
        return;
      }
      const res = await services.singleTurn({
        provider: args.provider,
        prompt:   args.prompt,
        signal:   ctx.signal,
        ...(typeof args.system === 'string' ? { system: args.system } : {}),
      });
      yield { type: 'result', value: { text: res.text, usage: res.usage } };
    },
  };

  return {
    name: 'single_turn',
    description:
      'Run a single-turn completion against another configured provider and return its reply. This is ' +
      'a one-shot call to a SEPARATE model — not your own response: you send one `prompt` (and optional ' +
      '`system`) to the named `provider`, and get back its text and token usage. Use it to consult a ' +
      'different model — e.g. a second, different-lineage model critiquing your draft, or any generation ' +
      'that should run on a specific provider rather than the current conversation\'s model. The ' +
      '`provider` must already be configured in this install (list or add providers with the provider ' +
      'tool).\n\n' +
      'Parameters (TypeScript):\n' +
      '```ts\n' +
      '{ provider: string; prompt: string; system?: string }  // -> { text, usage: { inputTokens, outputTokens } }\n' +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['provider', 'prompt'],
      properties: {
        provider: { type: 'string', description: 'Name of a configured provider to run the completion against.' },
        prompt:   { type: 'string', description: 'The user message to send to that provider.' },
        system:   { type: 'string', description: 'Optional system prompt for the call.' },
      },
    },
    executor,
  };
}
