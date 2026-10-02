import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, installPrincipalCarrier, SessionAppendKind } from '@matatbread/matbot-core';
import type { MatbotMachine, Message, Notification, PluginSettings, Session, Store, Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { plugin as telegram } from '../../../plugins/frontend/telegram/src/plugin.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());

// A message reaches a Telegram user through their chat's session, so a reply in the chat has it in
// context. The chat keeps one session id for good. Archiving it (to drop the context) is undone when the
// chat next speaks, by moving the history out to a new archived session. That move used to take
// everything: a report appended to the archived session, delivered to the phone, was moved out exactly
// when the user replied to it.

const CHAT = 42;
const realFetch = globalThis.fetch;

const msg = (id: string, role: Message['role'], text: string): Message =>
  ({ id, role, content: [{ type: 'text', text }], createdAt: new Date(0).toISOString(), traceId: 't' }) as Message;

function harness(t: { after(fn: () => Promise<void> | void): void }, seed: Session, opts: { bootMisses?: string } = {}) {
  const docs = new Map<string, Session>([[seed.id, seed]]);
  const sessions = {
    get: async (id: string) => docs.get(id) ?? null,
    set: async (id: string, v: Session) => { docs.set(id, v); },
    cas: async (id: string, expected: string, next: Session) => {
      const cur = docs.get(id);
      if (!cur || cur.version !== expected) return { ok: false as const, doc: cur ?? null };
      docs.set(id, next);
      return { ok: true as const, doc: next };
    },
    delete: async (id: string) => docs.delete(id),
    query: async () => ({ items: [...docs.values()] }),
  } as unknown as Store<Session>;

  const stored: Record<string, unknown> = { knownChats: [CHAT], [`chat:${CHAT}`]: seed.id, [`user:${CHAT}`]: { name: 'Ann' } };
  let booting = true;
  const settings: PluginSettings = {
    get: async <T>(key: string) => {
      if (booting && key === opts.bootMisses) throw new Error('unreadable at boot');
      return stored[key] as T | undefined;
    },
    set: async (key, value) => { stored[key] = value; },
    delete: async key => { delete stored[key]; },
    entries: async () => ({ ...stored }),
  };

  const sent: Array<{ chatId: number; text: string }> = [];
  const updates: unknown[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/getUpdates')) {
      await new Promise(r => setTimeout(r, 5));
      return new Response(JSON.stringify({ ok: true, result: updates.splice(0) }));
    }
    if (u.includes('/sendMessage')) {
      const body = JSON.parse(String(init?.body)) as { chat_id: number; text: string };
      sent.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    }
    return new Response(JSON.stringify({ ok: true, result: true }));
  }) as typeof fetch;

  // What a turn the chat starts would read: the session as stored when it was submitted.
  const opened: Session[] = [];
  let onAppend: ((n: Notification) => void) | undefined;
  const tools = new Map<string, Tool>();
  const services = {
    Vault:            { resolve: async () => 'TOKEN' },
    sessions,
    providers:        new Map([['fake', {}]]),
    registerFrontend: () => {},
    isSubAgent:       () => false,
    settings:         () => settings,
    tools:            { register: (tool: Tool) => { tools.set(tool.name, tool); } },
    Notifier:         { consume: (handler: (n: Notification) => void) => { onAppend = handler; } },
    run: {
      status: () => ({ busy: false, running: false, queued: 0, parallel: 0 }),
      // No turn holds the session here, so a write is made at once — after the call returns, as the runner's is.
      write:  (_id: string, attempt: () => Promise<boolean>) => ({
        deferred: false,
        done:     Promise.resolve().then(async () => { for (let n = 0; n < 3; n++) if (await attempt()) return; }),
      }),
      open:   async (o: { sessionId: string }) => {
        opened.push(docs.get(o.sessionId)!);
        return { traceId: 'turn', session: docs.get(o.sessionId)!, queued: 0, events: (async function* () { yield { type: 'idle', sessionId: o.sessionId }; })() };
      },
    },
  } as unknown as MatbotMachine;

  t.after(async () => { await telegram.teardown?.(); globalThis.fetch = realFetch; });
  return {
    docs, sent, opened, tools: () => new Map(telegram.tools?.map(tool => [tool.name, tool])),
    async start() { await telegram.setup!(services); booting = false; },
    // What the core appender does: write the messages, then announce which ids arrived.
    append(sessionId: string, messages: Message[]) {
      const cur = docs.get(sessionId)!;
      docs.set(sessionId, { ...cur, version: crypto.randomUUID(), messages: [...cur.messages, ...messages] });
      onAppend!({ kind: SessionAppendKind, sessionId, messageIds: messages.map(m => m.id), principal: { id: 'job-owner', type: 'user' } } as unknown as Notification);
    },
    speak(text: string) {
      updates.push({ update_id: 1, message: { message_id: 1, chat: { id: CHAT }, from: { id: 1, first_name: 'Ann' }, text } });
    },
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(cond(), 'timed out');
}

const archived = (): Session => ({
  ...createSession(), id: 'chat-session', status: 'archived',
  messages: [msg('u0', 'user', 'old question'), msg('a0', 'assistant', 'old answer')],
});

test('a report appended to an archived chat session stays in the context the reply runs in', { timeout: 10000 }, async t => {
  const h = harness(t, archived());
  await h.start();

  h.append('chat-session', [msg('r1', 'assistant', 'the build finished')]);
  await until(() => h.sent.some(s => s.text === '🤖 the build finished'));
  await until(() => h.docs.get('chat-session')!.status === 'active');

  const live = h.docs.get('chat-session')!;
  assert.deepEqual(live.messages.map(m => m.role === 'marker' ? 'marker' : m.id), ['marker', 'r1'], 'the old history moved out, the report kept');
  const archive = [...h.docs.values()].find(s => s.id !== 'chat-session')!;
  assert.deepEqual(archive.messages.map(m => m.role === 'marker' ? 'marker' : m.id), ['u0', 'a0', 'marker']);

  h.speak('thanks — did the tests pass?');
  await until(() => h.opened.length > 0);
  assert.ok(h.opened[0]!.messages.some(m => m.id === 'r1'), 'the reply runs with the report in its history');
  assert.equal(h.opened[0]!.id, 'chat-session', 'under the id it always had');
});

test('looking a chat up does not move its history', { timeout: 10000 }, async t => {
  const h = harness(t, archived());
  await h.start();

  const tool = h.tools().get('telegram_session')!;
  const events: Array<{ type: string; value?: unknown }> = [];
  for await (const ev of tool.executor.execute({ user: 'Ann' }, {} as ToolContext)) events.push(ev as never);
  const value = events.find(e => e.type === 'result')?.value as { chats: Array<{ sessionId: string | null }> };
  assert.equal(value.chats[0]?.sessionId, 'chat-session');

  const after = h.docs.get('chat-session')!;
  assert.equal(after.status, 'archived', 'still archived');
  assert.deepEqual(after.messages.map(m => m.id), ['u0', 'a0'], 'and still holding its history');
  assert.equal(h.docs.size, 1, 'no archive copy was made');
});

test('an append to a chat session the boot read missed is still delivered', { timeout: 10000 }, async t => {
  const active: Session = { ...createSession(), id: 'chat-session', messages: [] };
  const h = harness(t, active, { bootMisses: `chat:${CHAT}` });
  await h.start();

  h.append('chat-session', [msg('r1', 'assistant', 'the build finished')]);
  await until(() => h.sent.length > 0);
  assert.deepEqual(h.sent, [{ chatId: CHAT, text: '🤖 the build finished' }]);
});
