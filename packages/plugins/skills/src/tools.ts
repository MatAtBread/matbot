import type { Tool, ToolExecutor, ToolContext, ToolEvent, MatbotServices } from '@matatbread/matbot-plugin-api';
import type { SkillManager } from './manager.js';

// The precise per-action contract. JSON Schema can't express "content required only for save"
// without an awkward oneOf, so the schema stays loose and the description carries this TypeScript
// discriminated union — which LLMs read accurately — as the source of truth. The executor enforces it.
type SkillInput =
  | { action: 'list' }
  | { action: 'load';     name: string }
  | { action: 'use';      name: string }
  | { action: 'metadata'; name: string }
  | { action: 'save';     name: string; content: string; catalogue?: boolean }
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

        case 'use': {
          // Like load, but the content is wrapped as a directive — "apply this skill now" — rather
          // than returned as raw reference text. This is what a firing trigger (or the model, when it
          // means to *act* on a skill rather than read it) wants: it carries the imperative the old
          // "Use the skill X" resubmit had, with the content inlined so there's no second round-trip.
          const { name } = args as Extract<SkillInput, { action: 'use' }>;
          if (!name) { yield { type: 'error', message: 'action "use" requires "name".' }; return; }
          const doc = manager.get(name);
          if (!doc) { yield { type: 'error', message: `Skill not found: "${name}"` }; return; }
          yield { type: 'result', value: {
            id:      doc.id,
            name:    doc.name,
            content: `Follow the instructions in the skill "${doc.name}" in your reply. Apply them now — ` +
                     `they take precedence over brevity or staying on the prior topic.\n\n${doc.content}`,
          } };
          return;
        }

        case 'metadata': {
          const { name } = args as Extract<SkillInput, { action: 'metadata' }>;
          if (!name) { yield { type: 'error', message: 'action "metadata" requires "name".' }; return; }
          const doc = manager.get(name);
          if (!doc) { yield { type: 'error', message: `Skill not found: "${name}"` }; return; }
          // Derived LLM analysis (absent until the background analysis has run and cached it), plus
          // `catalogue` — whether the skill is advertised in the system prompt.
          yield { type: 'result', value: { id: doc.id, name: doc.name, knowledge: doc.knowledge ?? null, catalogue: doc.catalogue ?? false } };
          return;
        }

        case 'save': {
          const { name, content, catalogue } = args as Extract<SkillInput, { action: 'save' }>;
          if (!name) { yield { type: 'error', message: 'action "save" requires "name".' }; return; }
          if (content === undefined) { yield { type: 'error', message: 'action "save" requires "content".' }; return; }
          if (catalogue !== undefined && typeof catalogue !== 'boolean') { yield { type: 'error', message: '"catalogue" must be a boolean.' }; return; }
          const doc = await manager.save(name, content, catalogue);
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
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: list, load, use, metadata, save, delete.` };
      }
    },
  };

  return {
    name: 'skill_action',
    description:
      'Manage skills — named, reusable markdown playbooks (procedures, conventions, reference ' +
      'notes) the assistant stores and recalls on demand. A skill is keyed by name (case-insensitive) ' +
      'and holds markdown content. Use this tool to list skills, load one (raw content, for reading or ' +
      'editing), use one (its content as a directive, to apply now), read its derived metadata, create ' +
      'or update one, or delete one.\n\n' +
      '`load` vs `use`: load returns the raw markdown (for inspection or editing); use returns the same ' +
      'content wrapped as an instruction to follow it now. A trigger that should make a skill take ' +
      'effect invokes `use`; tooling that reads a skill invokes `load`.\n\n' +
      'Most skills are surfaced by content search; to make one apply automatically on a behavioural ' +
      'condition, create a trigger with the `trigger_action` tool whose `invoke` is this tool with ' +
      '`{ action: "use", name }`.\n\n' +
      'Parameters depend on `action` (TypeScript):\n' +
      '```ts\n' +
      'type SkillAction =\n' +
      "  | { action: 'list' }                            // -> { skills: [{ id, name, toolBinding? }] }\n" +
      "  | { action: 'load';     name: string }          // raw content -> { id, name, content }\n" +
      "  | { action: 'use';      name: string }          // content as a directive to apply now -> { id, name, content }\n" +
      "  | { action: 'metadata'; name: string }          // derived analysis -> { id, name, knowledge: { summary, entities, tags } | null, catalogue: boolean }\n" +
      "  | { action: 'save';     name: string; content: string; catalogue?: boolean }  // create or update -> { id, name }; `catalogue` advertises the skill in the system prompt (omit to leave unchanged)\n" +
      "  | { action: 'delete';   name: string };         // -> { id, name }\n" +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:    { type: 'string', enum: ['list', 'load', 'use', 'metadata', 'save', 'delete'], description: 'The operation to perform.' },
        name:      { type: 'string', description: 'Skill name (case-insensitive). Required for load/use/metadata/save/delete.' },
        content:   { type: 'string', description: 'Skill content in markdown — required for action "save".' },
        catalogue: { type: 'boolean', description: 'Optional for "save": advertise this skill in the system prompt (using its generated summary). Omit to leave unchanged.' },
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
