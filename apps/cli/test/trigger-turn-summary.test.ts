import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotMachine, Message, MessageContent, Store } from '@matatbread/matbot-plugin-api';
import { setupTriggers } from '../../../plugins/triggers/src/index.ts';
import type { Trigger } from '../../../plugins/triggers/src/index.ts';
import { turnSummary } from '../../../plugins/triggers/src/plugin.ts';

// The classifier is shown each message's text alone, so a condition such as "no tool was called" or
// "the attachment is a PDF" could only be guessed at. Each side now closes with a bracketed summary.

const msg = (role: Message['role'], content: MessageContent[]): Message =>
  ({ id: crypto.randomUUID(), role, content }) as unknown as Message;
const text   = (t: string, origin?: 'robo'): MessageContent => ({ type: 'text', text: t, ...(origin ? { origin } : {}) }) as MessageContent;
const call   = (name: string): MessageContent => ({ type: 'tool-call', id: crypto.randomUUID(), name, input: {} });
const result = (): MessageContent => ({ type: 'tool-result', id: 'x', result: 'ok' });
const pdf: MessageContent = { type: 'file-ref', fileId: 'f1', name: 'def.pdf', mimeType: 'application/pdf' };
const png: MessageContent = { type: 'image', data: '', mimeType: 'image/png' };

test('a user message lists its own attachments, and nothing when it has none', () => {
  const u = msg('user', [text('see attached'), pdf, png]);
  assert.equal(turnSummary([u], u), '[Files in this turn: def.pdf (application/pdf), image (image/png)]');
  const plain = msg('user', [text('hi')]);
  assert.equal(turnSummary([plain], plain), undefined);
});

test('an assistant message lists every tool call in its turn, across rounds, and only its turn', () => {
  const earlier = [msg('user', [text('q0')]), msg('assistant', [call('bash')]), msg('tool', [result()]), msg('assistant', [text('a0')])];
  const reply   = msg('assistant', [text('done')]);
  const turn    = [
    msg('user', [text('q1'), pdf]),
    msg('assistant', [text('looking'), call('http'), call('tool_function')]), msg('tool', [result(), result()]),
    // A robo resubmit belongs to the same turn.
    msg('user', [text('steer', 'robo')]),
    msg('assistant', [call('http')]), msg('tool', [result()]),
    reply,
  ];
  const messages = [...earlier, ...turn, msg('user', [text('q2')])];
  assert.equal(turnSummary(messages, reply), '[Tool calls in this turn: http ×2, tool_function]');
  assert.equal(turnSummary(messages, earlier[3]), '[Tool calls in this turn: bash]');
});

test('an assistant turn with no tool calls says so', () => {
  const reply = msg('assistant', [text('a')]);
  assert.equal(turnSummary([msg('user', [text('q')]), reply], reply), '[Tool calls in this turn: none]');
  assert.equal(turnSummary([], undefined), undefined);
});

function machine(trigger: Trigger) {
  const hooks   = new Map<string, (ctx: never) => Promise<unknown>>();
  const prompts: string[] = [];
  const services = {
    createStore: () => ({ query: async () => ({ items: [trigger] }), get: async () => trigger }) as unknown as Store<Trigger>,
    register:    async (key: string, v: unknown) => { (services as Record<string, unknown>)[key] = v; },
    tools:       { register: () => {}, resolve: () => null, validate: async () => [] },
    hooks:       { register: (h: { on: string; handler: (ctx: never) => Promise<unknown> }) => { hooks.set(h.on, h.handler); } },
    settings:    () => ({ get: async () => undefined }),
    providers:   { has: () => false },
    singleTurn:  async (req: { prompt: string }) => { prompts.push(req.prompt); return { text: '{}' }; },
  };
  return { services: services as unknown as MatbotMachine, hooks, prompts };
}

const trigger = (kind: Trigger['conditions'][number]['kind']): Trigger => ({
  id: 't1', version: '1', conditions: [{ kind, rule: 'MATCH if no tool was called' }], invoke: { tool: 'x' },
  createdAt: '', updatedAt: '',
});
const signal = new AbortController().signal;

test('the agent-surface classifier is shown each side\'s summary after its text', async () => {
  const { services, hooks, prompts } = machine(trigger('followup'));
  await setupTriggers(services);
  const messages = [msg('user', [text('summarise this'), pdf]), msg('assistant', [call('http')]), msg('tool', [result()]), msg('assistant', [text('here')])];
  await hooks.get('followup')!({ session: { id: 's', version: '1', messages }, signal, resubmitDepth: 0, config: { provider: 'p' } } as never);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /PRECEDING USER MESSAGE \(earlier\) ===\nsummarise this\n\n\[Files in this turn: def\.pdf \(application\/pdf\)\]\n\n/);
  assert.match(prompts[0]!, /ASSISTANT RESPONSE \(later — judge the conditions against THIS\) ===\nhere\n\n\[Tool calls in this turn: http\]\n\n/);
});

test('a user message that is only an attachment is still judged', async () => {
  const { services, hooks, prompts } = machine(trigger('ephemeral'));
  await setupTriggers(services);
  const messages = [msg('user', [pdf])];
  await hooks.get('screen')!({ session: { id: 's', version: '1', messages }, signal, config: { provider: 'p', traceId: 'tr' } } as never);
  await hooks.get('followup')!({ session: { id: 's', version: '1', messages: [...messages, msg('assistant', [text('a')])] }, signal, resubmitDepth: 0, config: { provider: 'p', traceId: 'tr' } } as never);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /PRECEDING ASSISTANT MESSAGE \(earlier\) ===\n\(none\)\n\n/);
  assert.match(prompts[0]!, /LATEST USER MESSAGE \(later — judge the conditions against THIS\) ===\n\[Files in this turn: def\.pdf \(application\/pdf\)\]\n\n/);
});

test('on the user surface, the preceding reply says it called no tools', async () => {
  const { services, hooks, prompts } = machine(trigger('ephemeral'));
  await setupTriggers(services);
  const messages = [msg('user', [text('q0')]), msg('assistant', [text('a0')]), msg('user', [text('q1')])];
  await hooks.get('screen')!({ session: { id: 's', version: '1', messages }, signal, config: { provider: 'p', traceId: 'tr' } } as never);
  await hooks.get('followup')!({ session: { id: 's', version: '1', messages: [...messages, msg('assistant', [text('a1')])] }, signal, resubmitDepth: 0, config: { provider: 'p', traceId: 'tr' } } as never);
  assert.match(prompts[0]!, /PRECEDING ASSISTANT MESSAGE \(earlier\) ===\na0\n\n\[Tool calls in this turn: none\]\n\n/);
  assert.match(prompts[0]!, /LATEST USER MESSAGE \(later — judge the conditions against THIS\) ===\nq1\n\n=== CONDITIONS/);
});
