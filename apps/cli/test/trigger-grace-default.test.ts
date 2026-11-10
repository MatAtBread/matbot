import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeferredCorrection, MatbotMachine, Message, MessageContent, Store, Tool } from '@matatbread/matbot-plugin-api';
import { setupTriggers } from '../../../plugins/triggers/src/index.ts';
import type { Trigger } from '../../../plugins/triggers/src/index.ts';

// `classifierGraceMs` defaulted to 0, a pure race: the answer started at once and a user-surface verdict
// that fired after it committed retracted it and ran the turn again, so a matched trigger cost a whole
// discarded answer. The default now holds the answer for the verdict (10 s), and only a classifier slower
// than that races. `0` still means the race.

const RESULT = 'the routed context';

function machine(delayMs: number, settings: Record<string, unknown> = {}) {
  const trigger: Trigger = { id: 't1', version: '1', conditions: [{ kind: 'ephemeral', rule: 'CONTENT: asks about volume' }], invoke: { tool: 'route' }, createdAt: '', updatedAt: '' };
  const hooks = new Map<string, (ctx: never) => Promise<unknown>>();
  let invoked = 0;
  let settled = false;
  const route: Tool = {
    name: 'route', description: '', inputSchema: { type: 'object' },
    executor: { async *execute() { invoked++; yield { type: 'result', value: RESULT }; } },
  };
  const services = {
    createStore: () => ({ query: async () => ({ items: [trigger] }), get: async () => trigger }) as unknown as Store<Trigger>,
    register:    async (key: string, v: unknown) => { (services as Record<string, unknown>)[key] = v; },
    tools:       { register: () => {}, resolve: (n: string) => n === 'route' ? route : null, validate: async () => [] },
    hooks:       { register: (h: { on: string; handler: (ctx: never) => Promise<unknown> }) => { hooks.set(h.on, h.handler); } },
    settings:    () => ({ get: async (k: string) => settings[k] }),
    providers:   { has: () => false },
    singleTurn:  async () => {
      await new Promise(r => setTimeout(r, delayMs));
      settled = true;
      return { text: '{"t1#0": {"match": true, "why": "asks about volume"}}' };
    },
  };
  return { services: services as unknown as MatbotMachine, hooks, invoked: () => invoked, settled: () => settled };
}

const user      = (text: string): Message => ({ id: text, role: 'user', content: [{ type: 'text', text }] }) as unknown as Message;
const assistant = (text: string): Message => ({ id: text, role: 'assistant', content: [{ type: 'text', text }] }) as unknown as Message;
const session   = (messages: Message[]) => ({ id: 's', version: '1', messages });
const signal    = new AbortController().signal;
const text      = (c: MessageContent[] | undefined) => (c ?? []).map(x => x.type === 'text' ? x.text : '').join('\n');

type ScreenOut   = { ephemeral?: MessageContent[]; deferred?: { claim(): DeferredCorrection | undefined } } | undefined;
type FollowupOut = { retractAndRerun?: { context?: MessageContent[] }; markers?: MessageContent[] } | undefined;

const screen   = async (hooks: Map<string, (ctx: never) => Promise<unknown>>, messages: Message[]) =>
  await hooks.get('screen')!({ session: session(messages), signal, config: { provider: 'p', traceId: 'tr' } } as never) as ScreenOut;
const followup = async (hooks: Map<string, (ctx: never) => Promise<unknown>>, messages: Message[]) =>
  await hooks.get('followup')!({ session: session(messages), signal, resubmitDepth: 0, config: { provider: 'p', traceId: 'tr' } } as never) as FollowupOut;
const events   = (out: FollowupOut) => (out?.markers ?? []).map(m => (m as { data?: { event?: string } }).data?.event);

test('unset, the answer waits for the verdict: it is delivered before the first token and nothing is retracted', async () => {
  const m = machine(30);
  await setupTriggers(m.services);
  const q = [user('how many bids yesterday?')];
  const out = await screen(m.hooks, q);
  assert.ok(m.settled(), 'screen returned before the verdict');
  assert.equal(out?.deferred, undefined);
  assert.match(text(out?.ephemeral), new RegExp(RESULT));

  const after = await followup(m.hooks, [...q, assistant('42k')]);
  assert.equal(after?.retractAndRerun, undefined);
  assert.ok(events(after).includes('user-insitu-fired'));
  assert.equal(m.invoked(), 1);
});

test('classifierGraceMs: 0 races: the answer starts at once, and a verdict after it retracts it', async () => {
  const m = machine(30, { classifierGraceMs: 0 });
  await setupTriggers(m.services);
  const q = [user('how many bids yesterday?')];
  const out = await screen(m.hooks, q);
  assert.equal(m.settled(), false);
  assert.equal(out?.ephemeral, undefined);
  assert.equal(out?.deferred?.claim(), undefined, 'nothing to claim before the verdict');

  const after = await followup(m.hooks, [...q, assistant('42k')]);
  assert.match(text(after?.retractAndRerun?.context), new RegExp(RESULT));
  assert.ok(events(after).includes('user-retract-fired'));
});

test('a verdict slower than the hold falls back to the race', async () => {
  const m = machine(200, { classifierGraceMs: 20 });
  await setupTriggers(m.services);
  const q = [user('how many bids yesterday?')];
  const out = await screen(m.hooks, q);
  assert.equal(m.settled(), false);
  assert.ok(out?.deferred);

  const after = await followup(m.hooks, [...q, assistant('42k')]);
  assert.match(text(after?.retractAndRerun?.context), new RegExp(RESULT));
});
