import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotMachine, Message, Session, Store, Tool, ToolEvent } from '@matatbread/matbot-plugin-api';
import { dispatchTrigger, createTriggerActionTool, TriggerManager } from '../../../plugins/triggers/src/index.ts';
import type { Trigger } from '../../../plugins/triggers/src/index.ts';
import { invalidInvocationReport } from '../../../plugins/triggers/src/plugin.ts';

// A trigger's `invoke.params` is typed `unknown` and was stored unchecked, then passed verbatim — so a
// trigger written without params called its tool with `undefined`, which a validator rightly rejects
// (every tool input is an object), and the rejection went only to a marker the model cannot see.

const session = { id: 's', version: '1', messages: [] } as unknown as Session;

function memoryStore(): Store<Trigger> {
  const docs = new Map<string, Trigger>();
  return {
    query:  async () => ({ items: [...docs.values()] }),
    get:    async (id: string) => docs.get(id) ?? null,
    set:    async (id: string, doc: Trigger) => { docs.set(id, doc); },
    cas:    async (id: string, version: string, doc: Trigger) => {
      if (docs.get(id)?.version !== version) return { ok: false };
      docs.set(id, doc);
      return { ok: true };
    },
    delete: async (id: string) => { docs.delete(id); },
  } as unknown as Store<Trigger>;
}

// A stand-in for a registered ToolCallValidator: `noargs` takes an empty object, nothing else.
function machine(seen: unknown[], events: ToolEvent[] = [{ type: 'result', value: 'ok' }]): MatbotMachine {
  const noargs: Tool = {
    name: 'noargs', description: '', inputSchema: { type: 'object' },
    executor: { async *execute(input) { seen.push(input); yield* events; } },
  };
  return {
    tools: { resolve: (name: string) => name === 'noargs' ? noargs : null },
    ToolCallValidator: {
      validateToolCall: async (_tool: string, params: unknown) =>
        params !== null && typeof params === 'object' && Object.keys(params).length === 0
          ? []
          : [{ path: '.', message: 'expected an empty object' }],
    },
  } as unknown as MatbotMachine;
}

const trigger = (invoke: Trigger['invoke']): Trigger => ({
  id: 't1', version: '1', conditions: [{ kind: 'followup', rule: 'MATCH always' }], invoke,
  createdAt: '', updatedAt: '',
});

async function run(tool: Tool, input: unknown): Promise<ToolEvent[]> {
  const out: ToolEvent[] = [];
  for await (const ev of tool.executor.execute(input, {} as never)) out.push(ev);
  return out;
}

test('a trigger with no params calls its tool with {}, not undefined', async () => {
  const seen: unknown[] = [];
  const out = await dispatchTrigger(machine(seen), trigger({ tool: 'noargs' }), { session, signal: new AbortController().signal, provider: 'p' });
  assert.deepEqual(seen, [{}]);
  assert.equal(out.hadResult, true);
});

test('a rejected invocation is recorded with its code, so the next turn can report it', async () => {
  const events: ToolEvent[] = [{ type: 'error', message: 'Invalid input for tool "noargs": .: expected object', code: 422 }];
  const out = await dispatchTrigger(machine([], events), trigger({ tool: 'noargs' }), { session, signal: new AbortController().signal, provider: 'p' });
  assert.deepEqual(out.markers, [{ type: 'marker', creator: 'triggers',
    data: { triggerId: 't1', tool: 'noargs', error: 'Invalid input for tool "noargs": .: expected object', code: 422 } }]);
});

test('trigger_action refuses to store params the tool would reject', async () => {
  const services = machine([]);
  const manager  = new TriggerManager(memoryStore(), services);
  const tool     = createTriggerActionTool(manager, services) as unknown as Tool;
  const conditions = [{ kind: 'followup', rule: 'MATCH always' }];

  const bad = await run(tool, { action: 'add', conditions, tool: 'noargs', params: { extra: 1 } });
  assert.equal(bad[0]?.type, 'error');
  assert.match((bad[0] as { message: string }).message, /params do not match tool "noargs": \.: expected an empty object/);
  assert.equal((await manager.all()).length, 0);

  // Omitted params are checked as the {} the trigger will actually send.
  const ok = await run(tool, { action: 'add', conditions, tool: 'noargs' });
  assert.equal(ok[0]?.type, 'result');
  const id = (ok[0] as { value: { id: string } }).value.id;

  // An absent tool still fails soft: nothing declares its input, so nothing can refuse it.
  assert.equal((await run(tool, { action: 'add', conditions, tool: 'not_loaded', params: { any: 1 } }))[0]?.type, 'result');

  const update = await run(tool, { action: 'update', id, params: { extra: 1 } });
  assert.equal(update[0]?.type, 'error');
  assert.equal((await manager.get(id))?.invoke.params, undefined);

  const move = await run(tool, { action: 'move', tool: 'not_loaded', toTool: 'noargs', toParams: { extra: 1 } });
  assert.equal(move[0]?.type, 'error');
});

test('rejections are reported once: only those recorded since the previous genuine user message', () => {
  const marker = (triggerId: string, code?: number): Message => ({
    role: 'marker',
    content: [{ type: 'marker', creator: 'triggers', data: { triggerId, tool: 'noargs', error: 'bad input', ...(code !== undefined ? { code } : {}) } }],
  }) as unknown as Message;
  const user = (text: string, origin?: 'robo'): Message =>
    ({ role: 'user', content: [{ type: 'text', text, ...(origin ? { origin } : {}) }] }) as unknown as Message;

  const messages = [
    user('first'), marker('old', 422),
    user('second'), marker('ordinary-failure'), user('steer', 'robo'), marker('new', 422),
    user('third'),
  ];
  const report = invalidInvocationReport(messages, messages.length - 1);
  assert.ok(report);
  const text = (report[0] as { text: string }).text;
  assert.match(text, /trigger new/);
  assert.doesNotMatch(text, /trigger old|ordinary-failure/);

  assert.equal(invalidInvocationReport([user('only')], 0), undefined);
});
