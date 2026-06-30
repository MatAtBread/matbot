import type { Tool, ToolExecutor, ToolResult, ToolResultOf, ToolContext, MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { TriggerManager } from './manager.js';
import type { TriggerCondition, TriggerKind, Trigger } from './types.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    // One arm per action: a caller of `invokeTool(machine, 'trigger_action', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolResult / the multi-action note on ToolResults).
    trigger_action:
      | ToolResult<{ triggers: Trigger[] }, { action: 'list'   }>
      | ToolResult<{ triggers: Trigger[] }, { action: 'query'  }>
      | ToolResult<Trigger,                 { action: 'get'    }>
      | ToolResult<{ id: string },          { action: 'add'    }>
      | ToolResult<Trigger,                 { action: 'update' }>
      | ToolResult<{ id: string },          { action: 'remove' }>;
    triggers_config:
      | ToolResult<{ classifierProvider: string | null; available: string[] }, { action: 'get'   }>
      | ToolResult<{ classifierProvider: string },                             { action: 'set'   }>
      | ToolResult<{ classifierProvider: null },                               { action: 'clear' }>;
  }
}

const KINDS: readonly TriggerKind[] = ['ephemeral', 'contextual', 'retract', 'followup'];
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
  '   - "ephemeral": judge the USER MESSAGE (e.g. frustration, a fact worth surfacing now); run the ' +
  'tool and inject its output into the response about to be written — for THIS turn only, not kept.\n' +
  '   - "contextual": judge the USER MESSAGE; run the tool and fold its output DURABLY onto the user ' +
  "turn, so it persists into the conversation and every later turn sees it. Choose ephemeral vs " +
  'contextual by whether a match means "use this for this answer" vs "this should become part of the ' +
  'session".\n' +
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

export function createTriggerActionTool(manager: TriggerManager): Tool<ToolResultOf<'trigger_action'>> {
  const executor: ToolExecutor<ToolResultOf<'trigger_action'>> = {
    async *execute(input: unknown, _ctx: ToolContext) {
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
      "type TriggerKind = 'ephemeral' | 'contextual' | 'retract' | 'followup';  // ephemeral=judge user msg+inject for this turn; contextual=judge user msg+fold durably onto it; retract=wrong, redo; followup=stands, add steer turn\n" +
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
        conditions: { type: 'array', description: 'Conditions [{ kind: "ephemeral"|"contextual"|"retract"|"followup", rule: string }]. Required for add.',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['ephemeral', 'contextual', 'retract', 'followup'] }, rule: { type: 'string' } } } },
        tool:       { type: 'string', description: 'Name of the tool to invoke when a condition matches. Required for add.' },
        params:     { type: 'object', description: 'Params passed verbatim as the invoked tool\'s input.' },
        enabled:    { type: 'boolean', description: 'Set false to keep but disable the trigger.' },
      },
    },
    executor,
  };
}

/**
 * Get/set which provider the trigger classifier uses to judge conditions. The provider is an alias for
 * one of the already-configured providers, not a new one: unset, the classifier uses the current turn's
 * own provider (so triggers work with zero config); set it to pin a small/fast model. Resolved per
 * evaluation, so a change takes effect on the next turn without a restart.
 */
export function createTriggersConfigTool(services: MatbotMachine): Tool<ToolResultOf<'triggers_config'>> {
  const KEY = 'classifierProvider';
  const executor: ToolExecutor<ToolResultOf<'triggers_config'>> = {
    async *execute(input: unknown, _ctx: ToolContext) {
      const args      = input as { action?: string; provider?: string };
      const settings  = services.settings();
      const available = [...services.providers.keys()];
      switch (args.action) {
        case 'get': {
          const pinned = await settings.get<string>(KEY);
          yield { type: 'result', value: { classifierProvider: pinned ?? null, available } };
          return;
        }
        case 'set': {
          if (!args.provider) { yield { type: 'error', message: 'action "set" requires "provider".' }; return; }
          if (!services.providers.has(args.provider)) {
            yield { type: 'error', message: `Unknown provider "${args.provider}". Configured providers: ${available.join(', ') || '(none)'}.` };
            return;
          }
          await settings.set(KEY, args.provider);
          yield { type: 'result', value: { classifierProvider: args.provider } };
          return;
        }
        case 'clear': {
          await settings.delete(KEY);
          yield { type: 'result', value: { classifierProvider: null } };
          return;
        }
        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: get, set, clear.` };
      }
    },
  };

  return {
    name: 'triggers_config',
    description:
      'Configure the triggers subsystem. Currently one setting: `classifierProvider` — which configured ' +
      'provider judges trigger conditions. It is an alias for an existing provider, not a new one. Unset, ' +
      "the classifier uses the current turn's own provider; set it to pin a small/fast model. `get` " +
      'reports the current pin and the available provider names; `set` pins one (it must already be ' +
      'configured — see the provider tool); `clear` reverts to the turn provider.\n\n' +
      'Parameters (TypeScript):\n' +
      '```ts\n' +
      "type TriggersConfig =\n" +
      "  | { action: 'get' }                       // -> { classifierProvider: string | null, available }\n" +
      "  | { action: 'set'; provider: string }     // pin a provider -> { classifierProvider }\n" +
      "  | { action: 'clear' };                     // revert to the turn provider -> { classifierProvider: null }\n" +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:   { type: 'string', enum: ['get', 'set', 'clear'], description: 'The operation to perform.' },
        provider: { type: 'string', description: 'Name of an already-configured provider — required for "set".' },
      },
    },
    executor,
  };
}
