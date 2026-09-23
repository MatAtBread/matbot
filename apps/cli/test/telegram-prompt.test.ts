import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FormField, SessionRunner } from '@matatbread/matbot-plugin-api';
import { isPromptCancelledError } from '@matatbread/matbot-core';
import { createPrompter } from '../../../plugins/frontend/telegram/src/prompt.js';
import type { TelegramMessage } from '../../../plugins/frontend/telegram/src/bot.js';

// A turn's prompt rendered in a chat, answered by a button, a reply, or not at all. The Bot API is
// stubbed; what is pinned is the routing — which update answers which question, and who may answer.

const realFetch = globalThis.fetch;

interface Call { method: string; body: Record<string, unknown> }

function stubBotApi(): Call[] {
  const calls: Call[] = [];
  let id = 100;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++id } }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

function stubRunner(): { run: SessionRunner; cancelled: string[] } {
  const cancelled: string[] = [];
  const run = {
    cancelTurn: (id: string) => { cancelled.push(id); },
  } as unknown as SessionRunner;
  return { run, cancelled };
}

const gateField: FormField = {
  name: 'gate', label: 'Install plugin **"x"**?', type: 'select', default: 'deny',
  options: [{ value: 'deny', label: 'Deny' }, { value: 'allow', label: 'Allow' }, { value: 'always-gate', label: 'Always allow every plugin.add' }],
};

const alice = { id: 1, first_name: 'Alice' };
const bob   = { id: 2, first_name: 'Bob' };
const msg = (from: typeof alice, text: string, replyTo?: number): TelegramMessage =>
  ({ message_id: 1, chat: { id: 7, type: 'private' }, from, text, ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo } } : {}) });
const tick = () => new Promise(r => setImmediate(r));

test('a select is sent as buttons keyed by index, and a press resolves to the option VALUE', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubBotApi();
  const { run } = stubRunner();
  const p = createPrompter('T', run);

  const answer = p.promptFor(7, 's1', alice)(gateField);
  await tick();
  const sent = calls.find(c => c.method === 'sendMessage')!;
  assert.match(String(sent.body.text), /^Install plugin "x"\?/);   // markdown stripped
  const rows = (sent.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
  assert.deepEqual(rows.map(r => r[0]!.text), ['Deny', 'Allow', 'Always allow every plugin.add']);

  await p.onButton({ id: 'q', from: alice, data: rows[1]![0]!.callback_data });
  assert.equal(await answer, 'allow');
  assert.ok(calls.some(c => c.method === 'editMessageText' && /→ Allow \(Alice\)/.test(String(c.body.text))));
  assert.equal(p.pending(7), false);
});

test('only the sender being served can press a button', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubBotApi();
  const p = createPrompter('T', stubRunner().run);

  p.promptFor(7, 's1', alice)(gateField).catch(() => {});
  t.after(() => p.closeAll());
  await tick();
  const data = (calls[0]!.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[2]![0]!.callback_data;
  await p.onButton({ id: 'q', from: bob, data });
  assert.equal(p.pending(7), true);
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery' && /Only the person/.test(String(c.body.text))));
});

test('a stale button is told it expired', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubBotApi();
  const p = createPrompter('T', stubRunner().run);
  await p.onButton({ id: 'q', from: alice, data: 'p:zz:0' });
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery' && /expired/.test(String(c.body.text))));
});

test('another message while buttons wait cancels the question and its turn — never the default', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubBotApi();
  const { run, cancelled } = stubRunner();
  const p = createPrompter('T', run);

  const answer = p.promptFor(7, 's1', alice)({ ...gateField, default: 'allow' });
  await tick();
  assert.equal(p.onMessage(msg(alice, 'never mind, what time is it?')), 'none');   // it goes on to be a turn
  await assert.rejects(answer, isPromptCancelledError);
  assert.deepEqual(cancelled, ['s1']);
});

test("someone else's message leaves the question parked", async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubBotApi();
  const p = createPrompter('T', stubRunner().run);
  p.promptFor(7, 's1', alice)(gateField).catch(() => {});
  t.after(() => p.closeAll());
  await tick();
  assert.equal(p.onMessage(msg(bob, 'hello')), 'none');
  assert.equal(p.pending(7), true);
});

test('a free-text question is answered by the next message, which does not become a turn', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubBotApi();
  const p = createPrompter('T', stubRunner().run);

  const answer = p.promptFor(7, 's1', alice)('What is the repo called?');
  await tick();
  assert.deepEqual(calls[0]!.body.reply_markup, { force_reply: true, selective: true });
  assert.equal(p.onMessage(msg(alice, 'matbot')), 'answered');
  assert.equal(await answer, 'matbot');
});

test('allowOther accepts a reply to the question, but not a plain message', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubBotApi();
  const p = createPrompter('T', stubRunner().run);

  const answer = p.promptFor(7, 's1', alice)({ ...gateField, allowOther: true });
  await tick();
  assert.equal(p.onMessage(msg(alice, 'only on Tuesdays', 101)), 'answered');
  assert.equal(await answer, 'only on Tuesdays');
});

test('a password is refused, not asked, and the turn is not abandoned', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubBotApi();
  const { run, cancelled } = stubRunner();
  const p = createPrompter('T', run);
  await assert.rejects(p.promptFor(7, 's1', alice)({ name: 'k', label: 'API key', type: 'password' }),
    (e: unknown) => !isPromptCancelledError(e) && /cannot collect a secret/.test(String(e)));
  assert.equal(calls.length, 0);
  assert.deepEqual(cancelled, []);
});

test('cancelChat abandons every parked question in the chat', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubBotApi();
  const { run, cancelled } = stubRunner();
  const p = createPrompter('T', run);
  const answer = p.promptFor(7, 's1', alice)(gateField);
  await tick();
  assert.equal(p.cancelChat(7, '✖ Cancelled.'), 1);
  await assert.rejects(answer, isPromptCancelledError);
  assert.deepEqual(cancelled, ['s1']);
  assert.equal(p.cancelChat(7, '✖ Cancelled.'), 0);
});
