import type { Tool, ToolExecutor, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import type { TriggerManager } from './manager.js';
import type { TriggerCondition, TriggerKind } from './types.js';

const KINDS: readonly TriggerKind[] = ['augment', 'retract', 'followup'];
const isKind = (x: unknown): x is TriggerKind => typeof x === 'string' && (KINDS as readonly string[]).includes(x);

const GUIDANCE =
  'A trigger is a data-driven hook: a list of `conditions` and the single tool call (`invoke`) to ' +
  'make when ANY condition matches. The conditions are the OR — different ways to recognise the ' +
  'situation — and the invocation is the one consequence.\n\n' +
  'Each condition has a `kind` and a `rule`:\n' +
  '• The `rule` is a CONDITION on the FORM or SENTIMENT of a message, NOT its topic (topical ' +
  'relevance is found by search, so keyword/entity rules are redundant noise — do not write them). ' +
  'Phrase it as a single LLM-judged rubric "MATCH if the message is …; DO NOT MATCH if …".\n' +
  '• `kind` fixes WHAT is judged and WHAT happens when it matches:\n' +
  '   - "augment": judge the USER MESSAGE (e.g. frustration, a fact worth remembering); run the tool ' +
  'and inject its output into the response about to be written.\n' +
  '   - "retract": judge the ASSISTANT RESPONSE; the response is WRONG, so discard it and regenerate ' +
  'the turn with the output as context (e.g. a corrected field name invalidates everything downstream).\n' +
  '   - "followup": judge the ASSISTANT RESPONSE; the response STANDS but needs a steer or ' +
  'verification, so keep it and add a follow-up turn carrying the output (e.g. critique/verify the ' +
  'existing answer — it must remain in context). Choose retract vs followup by whether a match means ' +
  '"this is wrong" vs "look at this again".\n\n' +
  '`invoke` names a tool and its params, run verbatim when the trigger fires. If the tool produces ' +
  'a result, the model is woken with it; a pure side-effect tool (no result) runs silently. An ' +
  'invoke naming a tool that is not present fails soft — the trigger simply does nothing until it ' +
  'is. To fire a skill on a condition, invoke `skill_action` with `{ action: "use", name }` — `use` ' +
  'applies the skill as a directive (the firing case). (`{ action: "load" }` returns raw content for ' +
  'reading/editing, not for firing — a `load` result is bare text the model may misread as the user speaking.)';

type TriggerActionInput =
  | { action: 'list' }
  | { action: 'query';  tool?: string; params?: unknown }
  | { action: 'get';    id: string }
  | { action: 'add';    conditions: TriggerCondition[]; tool: string; params?: unknown; enabled?: boolean }
  | { action: 'update'; id: string; conditions?: TriggerCondition[]; tool?: string; params?: unknown; enabled?: boolean }
  | { action: 'remove'; id: string };

// A condition is valid if it has a recognised `kind` and a string `rule`.
function validConditions(x: unknown): x is TriggerCondition[] {
  return Array.isArray(x) && x.every(c =>
    c !== null && typeof c === 'object' &&
    isKind((c as { kind?: unknown }).kind) &&
    typeof (c as { rule?: unknown }).rule === 'string');
}

export function createTriggerActionTool(manager: TriggerManager): Tool {
  const executor: ToolExecutor = {
    async *execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args = input as Partial<TriggerActionInput> & { action?: string };

      switch (args.action) {
        case 'list': {
          yield { type: 'result', value: { triggers: manager.all() } };
          return;
        }

        case 'query': {
          const a = args as Extract<TriggerActionInput, { action: 'query' }>;
          yield { type: 'result', value: { triggers: manager.query({
            ...(typeof a.tool === 'string' ? { tool: a.tool } : {}),
            ...(a.params !== undefined ? { params: a.params } : {}),
          }) } };
          return;
        }

        case 'get': {
          const { id } = args as Extract<TriggerActionInput, { action: 'get' }>;
          if (!id) { yield { type: 'error', message: 'action "get" requires "id".' }; return; }
          const t = manager.get(id);
          if (!t) { yield { type: 'error', message: `Trigger not found: "${id}"` }; return; }
          yield { type: 'result', value: t };
          return;
        }

        case 'add': {
          const a = args as Extract<TriggerActionInput, { action: 'add' }>;
          if (!validConditions(a.conditions)) { yield { type: 'error', message: `action "add" requires "conditions": [{ kind: ${KINDS.join('|')}, rule: string }].` }; return; }
          if (a.conditions.length === 0)      { yield { type: 'error', message: 'action "add" requires at least one condition.' }; return; }
          if (typeof a.tool !== 'string')     { yield { type: 'error', message: 'action "add" requires a string "tool" to invoke.' }; return; }
          const t = await manager.add({
            conditions: a.conditions,
            invoke:     { tool: a.tool, ...(a.params !== undefined ? { params: a.params } : {}) },
            ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
          });
          yield { type: 'result', value: { id: t.id } };
          return;
        }

        case 'update': {
          const a = args as Extract<TriggerActionInput, { action: 'update' }>;
          if (!a.id) { yield { type: 'error', message: 'action "update" requires "id".' }; return; }
          if (a.conditions !== undefined && !validConditions(a.conditions)) { yield { type: 'error', message: '"conditions" must be [{ kind, rule }].' }; return; }
          if (a.tool !== undefined && typeof a.tool !== 'string')           { yield { type: 'error', message: '"tool" must be a string.' }; return; }
          const t = await manager.update(a.id, {
            ...(a.conditions !== undefined ? { conditions: a.conditions } : {}),
            ...(a.tool !== undefined || a.params !== undefined
              ? { invoke: { tool: a.tool ?? manager.get(a.id)?.invoke.tool ?? '', ...(a.params !== undefined ? { params: a.params } : {}) } }
              : {}),
            ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
          });
          if (t === undefined) { yield { type: 'error', message: `Trigger not found: "${a.id}"` }; return; }
          yield { type: 'result', value: t };
          return;
        }

        case 'remove': {
          const { id } = args as Extract<TriggerActionInput, { action: 'remove' }>;
          if (!id) { yield { type: 'error', message: 'action "remove" requires "id".' }; return; }
          const ok = await manager.remove(id);
          if (!ok) { yield { type: 'error', message: `Trigger not found: "${id}"` }; return; }
          yield { type: 'result', value: { id } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: list, query, get, add, update, remove.` };
      }
    },
  };

  return {
    name: 'trigger_action',
    description:
      'Manage triggers — data-driven hooks that invoke a tool when an LLM classifier judges one of ' +
      'their conditions matched against the current turn. Use this to list triggers, find the ones ' +
      'that invoke a given tool (query), read one, create one, edit one by id, or delete one.\n\n' +
      GUIDANCE + '\n\n' +
      'A trigger has a stable `id` — address it by that, never by its conditions. To change one, ' +
      '"get" or "list" first to read the id, then "update" by id.\n\n' +
      'Parameters depend on `action` (TypeScript):\n' +
      '```ts\n' +
      "type TriggerKind = 'augment' | 'retract' | 'followup';  // augment=judge user msg+inject; retract=wrong, redo; followup=stands, add steer turn\n" +
      'type TriggerCondition = { kind: TriggerKind; rule: string };\n' +
      'type TriggerAction =\n' +
      "  | { action: 'list' }                                                              // -> { triggers: [...] }\n" +
      "  | { action: 'query';  tool?: string; params?: object }                            // triggers invoking that tool -> { triggers: [...] }\n" +
      "  | { action: 'get';    id: string }                                                // -> the trigger\n" +
      "  | { action: 'add';    conditions: TriggerCondition[]; tool: string; params?: object; enabled?: boolean }  // -> { id }\n" +
      "  | { action: 'update'; id: string; conditions?: TriggerCondition[]; tool?: string; params?: object; enabled?: boolean }  // edit by id\n" +
      "  | { action: 'remove'; id: string };                                               // -> { id }\n" +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:     { type: 'string', enum: ['list', 'query', 'get', 'add', 'update', 'remove'], description: 'The operation to perform.' },
        id:         { type: 'string', description: 'Trigger id. Required for get/update/remove.' },
        conditions: { type: 'array', description: 'Conditions [{ kind: "augment"|"retract"|"followup", rule: string }]. Required for add.',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['augment', 'retract', 'followup'] }, rule: { type: 'string' } } } },
        tool:       { type: 'string', description: 'Name of the tool to invoke when a condition matches. Required for add.' },
        params:     { type: 'object', description: 'Params passed verbatim as the invoked tool\'s input.' },
        enabled:    { type: 'boolean', description: 'Set false to keep but disable the trigger.' },
      },
    },
    executor,
  };
}
