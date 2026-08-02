import type { Tool, ToolExecutor, ToolContract, ToolResultOf, ToolContext, MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { TriggerManager } from './manager.js';
import type { TriggerCondition, TriggerCooldown, TriggerKind, Trigger } from './types.js';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolContracts {
    // One arm per action: a caller of `invokeTool(machine, 'trigger_action', { action: '…' })` gets the
    // matching result narrowed by the `action` it passed (see ToolContract / the multi-action note on ToolContracts).
    trigger_action:
      | ToolContract<{ triggers: Trigger[] }, { action: 'list' }>
      | ToolContract<{ triggers: Trigger[] }, { action: 'query'; tool?: string; params?: object }>
      | ToolContract<Trigger,                 { action: 'get'; id: string }>
      | ToolContract<{ id: string },          { action: 'add'; conditions: TriggerCondition[]; tool: string; params?: object; enabled?: boolean; cooldown?: TriggerCooldown }>
      | ToolContract<Trigger,                 { action: 'update'; id: string; conditions?: TriggerCondition[]; tool?: string; params?: object; enabled?: boolean; cooldown?: TriggerCooldown }>
      | ToolContract<Trigger,                 { action: 'disable'; id: string }>
      | ToolContract<Trigger,                 { action: 'enable'; id: string }>
      | ToolContract<{ id: string },          { action: 'remove'; id: string }>
      | ToolContract<{ triggers: Trigger[] }, { action: 'move'; tool?: string; params?: object; toTool: string; toParams?: object }>
      | ToolContract<{ triggers: Trigger[] }, { action: 'copy'; tool?: string; params?: object; toTool: string; toParams?: object }>;
    triggers_config:
      | ToolContract<{ classifierProvider: string | null; available: string[] }, { action: 'get' }>
      | ToolContract<{ classifierProvider: string },                             { action: 'set'; provider: string }>
      | ToolContract<{ classifierProvider: null },                               { action: 'clear' }>;
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
  'reading/editing, not for firing — a `load` result is bare text the model may misread as the user speaking.)\n\n' +
  'An optional `cooldown` rate-limits firing independently of matching — `{ maxPerTurn, quietTurns }`. ' +
  'A turn is one genuine user message and everything that follows it (a retract redo or a follow-up ' +
  'robo turn belongs to the turn that caused it). `maxPerTurn` caps fires within a turn across both ' +
  'surfaces; `quietTurns` holds the trigger off for that many LATER turns after a fire (1 ⇒ never on ' +
  'consecutive turns). Absent ⇒ unlimited, which is right for most triggers: a trigger that captures ' +
  'what the user just said SHOULD fire every turn, and rate-limiting it silently loses data. Use a ' +
  'cool-down for triggers whose consequence is a self-directed steer (critique, verify, reconsider), ' +
  'where matching every turn is correct but acting every turn is a spin.';

type TriggerActionInput =
  | { action: 'list' }
  | { action: 'query';  tool?: string; params?: unknown }
  | { action: 'get';    id: string }
  | { action: 'add';    conditions: TriggerCondition[]; tool: string; params?: unknown; enabled?: boolean; cooldown?: unknown }
  | { action: 'update'; id: string; conditions?: TriggerCondition[]; tool?: string; params?: unknown; enabled?: boolean; cooldown?: unknown }
  | { action: 'disable'; id: string }
  | { action: 'enable';  id: string }
  | { action: 'remove'; id: string }
  | { action: 'move';   tool?: string; params?: unknown; toTool: string; toParams?: unknown }
  | { action: 'copy';   tool?: string; params?: unknown; toTool: string; toParams?: unknown };

// The query selector shared by query/move/copy: `tool`/`params` narrow the set by what a trigger invokes.
function queryFilter(a: { tool?: unknown; params?: unknown }): { tool?: string; params?: unknown } {
  return {
    ...(typeof a.tool === 'string' ? { tool: a.tool } : {}),
    ...(a.params !== undefined ? { params: a.params } : {}),
  };
}

// A cool-down is valid if every field it carries is a non-negative integer. `null` clears it (the
// only way back to "unlimited" through a patch, since an omitted field means "leave unchanged").
function validCooldown(x: unknown): x is TriggerCooldown {
  if (x === null || typeof x !== 'object') return false;
  const c = x as { maxPerTurn?: unknown; quietTurns?: unknown };
  const ok = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
  return ok(c.maxPerTurn) && ok(c.quietTurns);
}

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
          yield { type: 'result', value: { triggers: await manager.all() } };
          return;
        }

        case 'query': {
          const a = args as Extract<TriggerActionInput, { action: 'query' }>;
          yield { type: 'result', value: { triggers: await manager.query(queryFilter(a)) } };
          return;
        }

        case 'get': {
          const { id } = args as Extract<TriggerActionInput, { action: 'get' }>;
          if (!id) { yield { type: 'error', message: 'action "get" requires "id".' }; return; }
          const t = await manager.get(id);
          if (!t) { yield { type: 'error', message: `Trigger not found: "${id}"` }; return; }
          yield { type: 'result', value: t };
          return;
        }

        case 'add': {
          const a = args as Extract<TriggerActionInput, { action: 'add' }>;
          if (!validConditions(a.conditions)) { yield { type: 'error', message: `action "add" requires "conditions": [{ kind: ${KINDS.join('|')}, rule: string }].` }; return; }
          if (a.conditions.length === 0)      { yield { type: 'error', message: 'action "add" requires at least one condition.' }; return; }
          if (typeof a.tool !== 'string')     { yield { type: 'error', message: 'action "add" requires a string "tool" to invoke.' }; return; }
          if (a.cooldown !== undefined && !validCooldown(a.cooldown)) { yield { type: 'error', message: '"cooldown" must be { maxPerTurn?: integer >= 0, quietTurns?: integer >= 0 }.' }; return; }
          const t = await manager.add({
            conditions: a.conditions,
            invoke:     { tool: a.tool, ...(a.params !== undefined ? { params: a.params } : {}) },
            ...(a.enabled  !== undefined ? { enabled:  a.enabled            } : {}),
            ...(a.cooldown !== undefined ? { cooldown: a.cooldown as TriggerCooldown } : {}),
          });
          yield { type: 'result', value: { id: t.id } };
          return;
        }

        case 'update': {
          const a = args as Extract<TriggerActionInput, { action: 'update' }>;
          if (!a.id) { yield { type: 'error', message: 'action "update" requires "id".' }; return; }
          if (a.conditions !== undefined && !validConditions(a.conditions)) { yield { type: 'error', message: '"conditions" must be [{ kind, rule }].' }; return; }
          if (a.tool !== undefined && typeof a.tool !== 'string')           { yield { type: 'error', message: '"tool" must be a string.' }; return; }
          if (a.cooldown !== undefined && a.cooldown !== null && !validCooldown(a.cooldown)) { yield { type: 'error', message: '"cooldown" must be { maxPerTurn?: integer >= 0, quietTurns?: integer >= 0 }, or null to remove every limit.' }; return; }
          const priorTool = (a.tool !== undefined || a.params !== undefined)
            ? (await manager.get(a.id))?.invoke.tool ?? ''
            : '';
          const t = await manager.update(a.id, {
            ...(a.conditions !== undefined ? { conditions: a.conditions } : {}),
            ...(a.tool !== undefined || a.params !== undefined
              ? { invoke: { tool: a.tool ?? priorTool, ...(a.params !== undefined ? { params: a.params } : {}) } }
              : {}),
            ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
            // null clears every limit; an omitted `cooldown` leaves the stored one untouched.
            ...(a.cooldown !== undefined ? { cooldown: (a.cooldown === null ? {} : a.cooldown) as TriggerCooldown } : {}),
          });
          if (t === undefined) { yield { type: 'error', message: `Trigger not found: "${a.id}"` }; return; }
          yield { type: 'result', value: t };
          return;
        }

        // Suspend/resume: keep the trigger but flip whether `evaluate` considers it. Less aggressive
        // than `remove` — the conditions and invocation are preserved, so re-enabling restores it
        // exactly. The go-to when a trigger fires too eagerly and you want to stop it without losing it.
        case 'disable':
        case 'enable': {
          const { id } = args as Extract<TriggerActionInput, { action: 'disable' | 'enable' }>;
          if (!id) { yield { type: 'error', message: `action "${args.action}" requires "id".` }; return; }
          const t = await manager.update(id, { enabled: args.action === 'enable' });
          if (t === undefined) { yield { type: 'error', message: `Trigger not found: "${id}"` }; return; }
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

        case 'move': {
          const a = args as Extract<TriggerActionInput, { action: 'move' }>;
          if (typeof a.toTool !== 'string')                  { yield { type: 'error', message: 'action "move" requires a string "toTool" to re-target the selected triggers onto.' }; return; }
          if (a.tool === undefined && a.params === undefined) { yield { type: 'error', message: 'action "move" requires a filter ("tool" and/or "params") selecting which triggers to re-target — refusing to move every trigger.' }; return; }
          const invoke = { tool: a.toTool, ...(a.toParams !== undefined ? { params: a.toParams } : {}) };
          const triggers: Trigger[] = [];
          for (const t of await manager.query(queryFilter(a))) {
            const updated = await manager.update(t.id, { invoke });
            if (updated !== undefined) triggers.push(updated);
          }
          yield { type: 'result', value: { triggers } };
          return;
        }

        case 'copy': {
          const a = args as Extract<TriggerActionInput, { action: 'copy' }>;
          if (typeof a.toTool !== 'string')                  { yield { type: 'error', message: 'action "copy" requires a string "toTool" to point the duplicates at.' }; return; }
          if (a.tool === undefined && a.params === undefined) { yield { type: 'error', message: 'action "copy" requires a filter ("tool" and/or "params") selecting which triggers to duplicate — refusing to duplicate every trigger.' }; return; }
          const invoke = { tool: a.toTool, ...(a.toParams !== undefined ? { params: a.toParams } : {}) };
          const triggers: Trigger[] = [];
          for (const t of await manager.query(queryFilter(a))) {
            triggers.push(await manager.add({
              conditions: t.conditions,
              invoke,
              ...(t.enabled  !== undefined ? { enabled:  t.enabled  } : {}),
              ...(t.cooldown !== undefined ? { cooldown: t.cooldown } : {}),
            }));
          }
          yield { type: 'result', value: { triggers } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: list, query, get, add, update, disable, enable, remove, move, copy.` };
      }
    },
  };

  return {
    name: 'trigger_action',
    description:
      'Manage triggers — data-driven hooks that invoke a tool when an LLM classifier judges one of ' +
      'their conditions matched against the current turn. Use this to list triggers, find the ones ' +
      'that invoke a given tool (query), read one, create one, edit one by id, suspend one so it stops ' +
      'firing while keeping it (disable) or bring it back (enable), delete one, or bulk re-target a ' +
      'selected set onto a new tool — in place (move) or as duplicates (copy).\n\n' +
      'When a trigger fires too eagerly, prefer "disable" over "remove": it keeps the conditions and ' +
      'invocation intact (so "enable" restores it exactly) but excludes it from evaluation entirely.\n\n' +
      GUIDANCE + '\n\n' +
      'A trigger has a stable `id` — address it by that, never by its conditions. To change one, ' +
      '"get" or "list" first to read the id, then "update" by id.\n\n' +
      'For `move`/`copy`, `tool`/`params` are the SAME selector as `query` (they pick which triggers ' +
      'to act on); `toTool`/`toParams` are the new invocation. A filter is required — both refuse to ' +
      'act on the entire trigger set.',
    inputSchema: {
      type:       'object',
      required:   ['action'],
      properties: {
        action:     { type: 'string', enum: ['list', 'query', 'get', 'add', 'update', 'disable', 'enable', 'remove', 'move', 'copy'], description: 'The operation to perform.' },
        id:         { type: 'string', description: 'Trigger id. Required for get/update/disable/enable/remove.' },
        conditions: { type: 'array', description: 'Conditions [{ kind: "ephemeral"|"contextual"|"retract"|"followup", rule: string }]. Required for add.',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['ephemeral', 'contextual', 'retract', 'followup'] }, rule: { type: 'string' } } } },
        tool:       { type: 'string', description: 'For add: the tool to invoke. For query/move/copy: the selector matching invoke.tool.' },
        params:     { type: 'object', description: 'For add: params passed verbatim as the invoked tool\'s input. For query/move/copy: the selector matching invoke.params.' },
        toTool:     { type: 'string', description: 'New tool the selected triggers should invoke. Required for move/copy.' },
        toParams:   { type: 'object', description: 'New params for the selected triggers\' invocation (move/copy).' },
        enabled:    { type: 'boolean', description: 'On add/update, set false to keep but suspend the trigger (absent ⇒ enabled). To toggle an existing trigger, prefer the dedicated "disable"/"enable" actions.' },
        cooldown:   { type: ['object', 'null'], description: 'On add/update, rate-limit firing: { maxPerTurn, quietTurns }. Omit to leave unchanged (absent ⇒ unlimited); null on update removes every limit.',
          properties: { maxPerTurn: { type: 'integer', description: 'Most fires allowed within one turn.' }, quietTurns: { type: 'integer', description: 'Later turns held off after a fire; 1 ⇒ never on consecutive turns.' } } },
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
      'configured — see the provider tool); `clear` reverts to the turn provider.',
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
