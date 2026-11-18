import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotMachine, Message, MessageContent, Session, Store, Tool } from '@matatbread/matbot-plugin-api';
import { setupTriggers } from '../../../plugins/triggers/src/index.ts';
import type { Trigger, TriggerFilter, TriggerSurface } from '../../../plugins/triggers/src/index.ts';

// Nothing could withhold a trigger from one conversation: the classifier judged every stored condition on
// every turn. A `TriggerFilter`, registered by whichever plugin holds the policy, now sees the triggers a turn
// would judge and the conversation, and answers with the ones it may.

interface Request { system?: string; prompt: string }

function machine(triggers: Trigger[], reply: string) {
  const docs     = new Map(triggers.map(t => [t.id, t]));
  const hooks    = new Map<string, (ctx: never) => Promise<unknown>>();
  const requests: Request[] = [];
  const fired:    string[]  = [];
  const tool = (name: string): Tool => ({
    name, description: '', inputSchema: { type: 'object' },
    executor: { async *execute() { fired.push(name); yield { type: 'result', value: `${name} ran` }; } },
  });
  const services = {
    createStore: () => ({ query: async () => ({ items: [...docs.values()] }), get: async (id: string) => docs.get(id) ?? null }) as unknown as Store<Trigger>,
    register:    async (key: string, v: unknown) => { (services as Record<string, unknown>)[key] = v; },
    tools:       { register: () => {}, resolve: (n: string) => n.startsWith('tool-') ? tool(n) : null, validate: async () => [] },
    hooks:       { register: (h: { on: string; handler: (ctx: never) => Promise<unknown> }) => { hooks.set(h.on, h.handler); } },
    settings:    () => ({ get: async () => undefined }),
    providers:   { has: () => false },
    singleTurn:  async (req: Request) => { requests.push(req); return { text: reply }; },
  };
  const filter = (g: TriggerFilter | undefined) => { (services as Record<string, unknown>)['TriggerFilter'] = g; };
  return { services: services as unknown as MatbotMachine, hooks, requests, fired, filter };
}

const trigger = (id: string, kind: Trigger['conditions'][number]['kind']): Trigger => ({
  id, version: '1', conditions: [{ kind, rule: `rule of ${id}` }], invoke: { tool: `tool-${id}` }, createdAt: '', updatedAt: '',
});
const everything = (ids: string[]) => JSON.stringify({ matched: ids.map(id => ({ id: `${id}#0`, why: 'matched' })) });
// What the classifier was shown, wherever in the request the conditions sit.
const shown = (r: Request) => `${r.system ?? ''}\n${r.prompt}`;

const user      = (text: string): Message => ({ id: text, role: 'user', content: [{ type: 'text', text }] }) as unknown as Message;
const assistant = (text: string): Message => ({ id: text, role: 'assistant', content: [{ type: 'text', text }] }) as unknown as Message;
const signal    = new AbortController().signal;

async function turn(hooks: Map<string, (ctx: never) => Promise<unknown>>, s: Session, traceId: string) {
  const screened = await hooks.get('screen')!({ session: s, signal, config: { provider: 'p', traceId } } as never) as { ephemeral?: MessageContent[] } | undefined;
  const followed = await hooks.get('followup')!({
    session: { ...s, messages: [...s.messages, assistant('an answer')] }, signal, resubmitDepth: 0, config: { provider: 'p', traceId },
  } as never) as { resubmit?: unknown; retractAndRerun?: unknown } | undefined;
  return { screened, followed };
}

test('a filter registered after triggers is asked, with the conversation and the surface, and what it withholds is neither judged nor fired', async () => {
  const m = machine([trigger('data', 'ephemeral'), trigger('chat', 'ephemeral'), trigger('critic', 'followup')], everything(['data', 'chat', 'critic']));
  await setupTriggers(m.services);
  const asked: { ids: string[]; session: Session; surface: TriggerSurface }[] = [];
  m.filter({ admit(ts, ctx) { asked.push({ ids: ts.map(t => t.id), ...ctx }); return ts.filter(t => t.id !== 'data'); } });

  const s = { id: 'governed', version: '1', messages: [user('how many bids?')] } as unknown as Session;
  await turn(m.hooks, s, 'tr');

  assert.deepEqual(asked.map(a => [a.surface, a.ids, a.session.id]), [['user', ['data', 'chat'], 'governed'], ['agent', ['critic'], 'governed']]);
  assert.equal(m.requests.length, 2);
  assert.ok(shown(m.requests[0]!).includes('rule of chat'));
  assert.ok(!m.requests.some(r => shown(r).includes('rule of data') || shown(r).includes('[data#0]')), 'a withheld rule reached the classifier');
  assert.deepEqual(m.fired.sort(), ['tool-chat', 'tool-critic'], 'the classifier named the withheld trigger, and it fired anyway');
});

test('withdrawing the filter restores the trigger', async () => {
  const m = machine([trigger('data', 'ephemeral')], everything(['data']));
  await setupTriggers(m.services);
  m.filter({ admit: () => [] });
  await turn(m.hooks, { id: 's', version: '1', messages: [user('first')] } as unknown as Session, 'a');
  assert.equal(m.requests.length, 0, 'nothing left to judge, so no classifier call');
  assert.deepEqual(m.fired, []);

  m.filter(undefined);
  await turn(m.hooks, { id: 's', version: '1', messages: [user('second')] } as unknown as Session, 'b');
  assert.equal(m.requests.length, 1);
  assert.deepEqual(m.fired, ['tool-data']);
});

test('a filter cannot add a trigger or reorder them: its answer is read as a subset of what it was offered', async () => {
  const t = [trigger('a', 'followup'), trigger('b', 'followup'), trigger('c', 'followup')];
  const m = machine(t, '{}');
  await setupTriggers(m.services);
  m.filter({ admit: ts => [ts[2]!, trigger('stranger', 'followup'), ts[0]!] });
  await turn(m.hooks, { id: 's', version: '1', messages: [user('q')] } as unknown as Session, 'tr');
  const system = shown(m.requests[0]!);
  assert.ok(!system.includes('stranger'));
  assert.ok(!system.includes('[b#0]'));
  assert.ok(system.indexOf('[a#0]') < system.indexOf('[c#0]'), 'the stored order is kept, so the cached prompt does not churn');
});

test('a filter that throws is skipped: every trigger is judged', async () => {
  const m = machine([trigger('data', 'ephemeral')], everything(['data']));
  await setupTriggers(m.services);
  m.filter({ admit: () => { throw new Error('policy store down'); } });
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
  try {
    await turn(m.hooks, { id: 's', version: '1', messages: [user('q')] } as unknown as Session, 'tr');
  } finally { console.warn = warn; }
  assert.deepEqual(m.fired, ['tool-data']);
  assert.ok(warned.some(w => String(w).includes('policy store down')));
});
