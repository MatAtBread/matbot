import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotMachine, Message, MessageContent, Store, Tool, ToolEvent } from '@matatbread/matbot-plugin-api';
import { setupTriggers } from '../../../plugins/triggers/src/index.ts';
import type { Trigger } from '../../../plugins/triggers/src/index.ts';

// A fire whose tool yields no result (remember_fact) delivered nothing, so nothing recorded which
// condition fired it or the classifier's `why` — the one thing a false-positive post-mortem needs — and
// the cool-down, counted from fire markers alone, never saw it fire.

type Handler = (ctx: never) => Promise<unknown>;

function machine(triggers: Trigger[], events: ToolEvent[]) {
  const docs  = new Map(triggers.map(t => [t.id, t]));
  const hooks = new Map<string, Handler>();
  const silent: Tool = {
    name: 'silent', description: '', inputSchema: { type: 'object' },
    executor: { async *execute() { yield* events; } },
  };
  const services = {
    createStore: () => ({ query: async () => ({ items: [...docs.values()] }), get: async (id: string) => docs.get(id) ?? null }) as unknown as Store<Trigger>,
    register:    async (key: string, v: unknown) => { (services as Record<string, unknown>)[key] = v; },
    tools:       { register: () => {}, resolve: (n: string) => n === 'silent' ? silent : null, validate: async () => [] },
    hooks:       { register: (h: { on: string; handler: Handler }) => { hooks.set(h.on, h.handler); } },
    settings:    () => ({ get: async () => undefined }),
    providers:   { has: () => false },
    // Every condition matches, with its key as the evidence.
    singleTurn:  async (req: { prompt: string }) => ({
      text: JSON.stringify(Object.fromEntries([...req.prompt.matchAll(/--- \[(.+?)\] ---/g)].map(m => [m[1], { match: true, why: `evidence for ${m[1]}` }]))),
    }),
  };
  return { services: services as unknown as MatbotMachine, hooks };
}

const trigger = (kind: Trigger['conditions'][number]['kind'], extra: Partial<Trigger> = {}): Trigger => ({
  id: 't1', version: '1', conditions: [{ kind, rule: 'MATCH always' }], invoke: { tool: 'silent' },
  createdAt: '', updatedAt: '', ...extra,
});

const user      = (text: string): Message => ({ id: text, role: 'user', content: [{ type: 'text', text }] }) as unknown as Message;
const assistant = (text: string): Message => ({ id: text, role: 'assistant', content: [{ type: 'text', text }] }) as unknown as Message;
const session   = (messages: Message[]) => ({ id: 's', version: '1', messages });
const signal    = new AbortController().signal;

async function followup(hooks: Map<string, Handler>, messages: Message[], traceId?: string): Promise<MessageContent[]> {
  const out = await hooks.get('followup')!({
    session: session(messages), signal, resubmitDepth: 0, config: { provider: 'p', ...(traceId ? { traceId } : {}) },
  } as never) as { markers?: MessageContent[]; resubmit?: unknown; retractAndRerun?: unknown } | undefined;
  assert.equal(out?.resubmit, undefined);
  assert.equal(out?.retractAndRerun, undefined);
  return out?.markers ?? [];
}

const triggerMarkers = (markers: MessageContent[]) =>
  markers.filter(m => m.type === 'marker' && m.creator === 'triggers').map(m => (m as { data: unknown }).data);

test('an agent-phase silent fire records which condition fired and why', async () => {
  const toolMarker: ToolEvent = { type: 'marker', creator: 'silent', data: { did: 'something' } };
  const { services, hooks } = machine([trigger('followup')], [toolMarker]);
  await setupTriggers(services);
  const markers = await followup(hooks, [user('q'), assistant('a')]);
  assert.deepEqual(markers[0], { type: 'marker', creator: 'silent', data: { did: 'something' } });
  assert.deepEqual(triggerMarkers(markers), [{ event: 'silent-fired', surface: 'agent', triggers: [
    { id: 't1', matched: [{ index: 0, kind: 'followup', rule: 'MATCH always', why: 'evidence for t1#0' }] },
  ] }]);
});

test('a user-phase silent fire is traced on the user surface', async () => {
  const { services, hooks } = machine([trigger('ephemeral')], []);
  await setupTriggers(services);
  const messages = [user('q')];
  await hooks.get('screen')!({ session: session(messages), signal, config: { provider: 'p', traceId: 'tr' } } as never);
  const markers = await followup(hooks, [...messages, assistant('a')], 'tr');
  assert.deepEqual(triggerMarkers(markers), [{ event: 'silent-fired', surface: 'user', triggers: [
    { id: 't1', matched: [{ index: 0, kind: 'ephemeral', rule: 'MATCH always', why: 'evidence for t1#0' }] },
  ] }]);
});

test('a silent fire counts toward the trigger\'s cool-down', async () => {
  const { services, hooks } = machine([trigger('followup', { cooldown: { quietTurns: 1 } })], []);
  await setupTriggers(services);
  const fired = { id: 'm', role: 'marker', content: [{ type: 'marker', creator: 'triggers',
    data: { event: 'silent-fired', surface: 'agent', triggers: [{ id: 't1', matched: [] }] } }] } as unknown as Message;
  const markers = await followup(hooks, [user('q1'), assistant('a1'), fired, user('q2'), assistant('a2')]);
  const data = triggerMarkers(markers) as { event: string; cause?: string }[];
  assert.deepEqual(data.map(d => [d.event, d.cause]), [['suppressed', 'cooldown']]);
});

test('a failed fire carries its matched conditions on the error marker, and is not a silent fire', async () => {
  const { services, hooks } = machine([trigger('followup', { invoke: { tool: 'absent' } })], []);
  await setupTriggers(services);
  const markers = await followup(hooks, [user('q'), assistant('a')]);
  assert.deepEqual(triggerMarkers(markers), [{ triggerId: 't1', tool: 'absent', error: 'tool "absent" not registered',
    matched: [{ index: 0, kind: 'followup', rule: 'MATCH always', why: 'evidence for t1#0' }] }]);
});

test('a retract-redo leaves no trigger marker: nothing was evaluated, so nothing was held off', async () => {
  const { services, hooks } = machine([trigger('ephemeral')], []);
  await setupTriggers(services);
  const retraction = { id: 'r', role: 'marker', content: [{ type: 'marker', creator: 'matbot-retraction', data: {} }] } as unknown as Message;
  const out = await hooks.get('screen')!({ session: session([user('q'), retraction]), signal, config: { provider: 'p', traceId: 'tr' } } as never);
  assert.equal(out, undefined);
});
