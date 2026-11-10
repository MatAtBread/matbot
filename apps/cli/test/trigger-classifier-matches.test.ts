import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotMachine, Message, MessageContent, Store, Tool } from '@matatbread/matbot-plugin-api';
import { setupTriggers } from '../../../plugins/triggers/src/index.ts';
import type { Trigger } from '../../../plugins/triggers/src/index.ts';

// The classifier asked for a `{ match, why }` verdict on EVERY condition, after the exchange in the user
// prompt. Output tokens are what take the time: 125 conditions cost ~6,500 of them and about two minutes,
// so the verdict landed after the answer and the turn was retracted and rerun. And with the conditions
// after the exchange, the only prefix a provider could cache was the rubric. Now the conditions are in the
// system prompt, which is stable while the trigger set is, and the reply names the matches alone.

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
  return { services: services as unknown as MatbotMachine, hooks, requests, fired };
}

const trigger = (id: string, rule: string): Trigger => ({
  id, version: '1', conditions: [{ kind: 'followup', rule }], invoke: { tool: `tool-${id}` }, createdAt: '', updatedAt: '',
});
const triggers = [trigger('t1', 'FORM: the reply apologises'), trigger('t2', 'CONTENT: the reply names a date'), trigger('t3', 'SENTIMENT: the reply gloats')];

const msg = (role: 'user' | 'assistant', text: string): Message => ({ id: text, role, content: [{ type: 'text', text }] }) as unknown as Message;
const signal = new AbortController().signal;

async function judge(hooks: Map<string, (ctx: never) => Promise<unknown>>, q: string, a: string) {
  return await hooks.get('followup')!({
    session: { id: 's', version: '1', messages: [msg('user', q), msg('assistant', a)] }, signal, resubmitDepth: 0, config: { provider: 'p' },
  } as never) as { resubmit?: { content: MessageContent[] }; markers?: MessageContent[] } | undefined;
}

const firedMatches = (markers: MessageContent[] | undefined) => (markers ?? [])
  .flatMap(m => m.type === 'marker' && m.creator === 'triggers' && (m.data as { event?: string }).event === 'followup-fired'
    ? (m.data as { triggers: { id: string; matched: { why?: string }[] }[] }).triggers : []);

test('the conditions are in the system prompt, and the exchange alone is the prompt', async () => {
  const { services, hooks, requests } = machine(triggers, '{}');
  await setupTriggers(services);
  await judge(hooks, 'when is it due?', 'Sorry — on 3 May.');
  await judge(hooks, 'and the next one?', 'The 9th, I think.');
  assert.equal(requests.length, 2);
  for (const t of triggers) assert.ok(requests[0]!.system?.includes(`--- [${t.id}#0] ---\n${t.conditions[0]!.rule}`), t.id);
  for (const t of triggers) assert.ok(!requests[0]!.prompt.includes(t.conditions[0]!.rule), `${t.id} in the prompt`);
  assert.match(requests[0]!.prompt, /ASSISTANT RESPONSE \(later — judge the conditions against THIS\) ===\nSorry — on 3 May\.\n\n\[Tool calls in this turn: none\]$/);
  assert.ok(!requests[0]!.system!.includes('3 May'));
  assert.equal(requests[1]!.system, requests[0]!.system, 'a second exchange reuses the same system prompt');
});

test('the classifier is asked for the matches alone, and only those fire, each with its evidence', async () => {
  const { services, hooks, requests, fired } = machine(triggers, 'Here: {"t2#0": "names 3 May"}');
  await setupTriggers(services);
  const out = await judge(hooks, 'when is it due?', 'On 3 May.');
  assert.match(requests[0]!.system!, /Omit every condition that does not match; if none match, return \{\}/);
  assert.deepEqual(fired, ['tool-t2']);
  assert.deepEqual(firedMatches(out?.markers), [{ id: 't2', matched: [{ index: 0, kind: 'followup', rule: 'CONTENT: the reply names a date', why: 'names 3 May' }] }]);
});

test('a reply in the per-condition shape still counts only what it marked matched', async () => {
  const reply = JSON.stringify({ 't1#0': { match: false, why: 'no apology' }, 't2#0': { match: true, why: 'a date' }, 't3#0': true });
  const { services, hooks, fired } = machine(triggers, reply);
  await setupTriggers(services);
  const out = await judge(hooks, 'when?', 'On 3 May, obviously.');
  assert.deepEqual(fired, ['tool-t2', 'tool-t3']);
  assert.deepEqual(firedMatches(out?.markers).map(t => [t.id, t.matched[0]?.why]), [['t2', 'a date'], ['t3', undefined]]);
});

test('an id the classifier was not asked about fires nothing', async () => {
  const { services, hooks, fired } = machine(triggers, '{"t9#0": "made up", "t1#4": "no such condition"}');
  await setupTriggers(services);
  assert.equal(await judge(hooks, 'q', 'a'), undefined);
  assert.deepEqual(fired, []);
});
