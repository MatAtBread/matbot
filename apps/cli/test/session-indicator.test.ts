import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, runAs } from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent, Message, Principal,
  PromptFn, SessionRunner, ToolContext,
} from '@matatbread/matbot-core';
import { isUnread, makeSessionTools, sessionIndicator, type SessionSummary } from '@matatbread/matbot-sessions';
import { createAlsPrincipalCarrier, createAlsUsageCarrier } from '@matatbread/matbot-host-node';
import { heldRunner } from './fixtures/held-runner.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// What a session list shows beside a session: prompting (red), running (amber) or unread (green). Unread
// was a set in the page's memory, filled when a turn ended in a session not on screen — so an append, which
// runs no turn, never lit it, and nothing that happened while no page was open ever did. It is now stored,
// as how far the session has been read, and the live two come from the runner.

const principal: Principal = { id: 'tester', type: 'user' };

const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const msg = (id: string, n: number, role: Message['role'] = 'assistant'): Message =>
  ({ id, role, content: [{ type: 'text', text: id }], createdAt: at(n), traceId: 't' }) as Message;

function casStore(...seed: Session[]): { store: Store<Session>; docs: Map<string, Session> } {
  const docs = new Map(seed.map(s => [s.id, s]));
  const store = {
    get: async (id: string) => docs.get(id) ?? null,
    set: async (id: string, v: Session) => { docs.set(id, v); },
    cas: async (id: string, expected: string, next: Session) => {
      const cur = docs.get(id);
      if (!cur || cur.version !== expected) return { ok: false as const, current: cur ?? null };
      docs.set(id, next);
      return { ok: true as const, doc: next };
    },
    delete: async (id: string) => docs.delete(id),
    query: async () => ({ items: [...docs.values()] }),
  } as unknown as Store<Session>;
  return { store, docs };
}

const caller = { callId: 'c1', signal: new AbortController().signal, session: { id: 'caller', messages: [] } } as unknown as ToolContext;

async function call(tool: Tool, input: unknown): Promise<unknown> {
  return runAs(principal, async () => {
    for await (const ev of tool.executor.execute(input, caller)) {
      if (ev.type === 'result') return ev.value;
      if (ev.type === 'error') throw new Error(ev.message);
    }
    throw new Error('no result');
  });
}

const settle = () => new Promise<void>(r => setTimeout(r, 10));

test('a session is unread while it has activity after the point it was read to', () => {
  const base = { ...createSession(), createdAt: at(0), readAt: at(0) };
  assert.equal(isUnread(base), false, 'nothing yet');
  assert.equal(isUnread({ ...base, messages: [msg('a', 1)] }), true, 'a message since');
  assert.equal(isUnread({ ...base, messages: [msg('a', 1)], readAt: at(1) }), false, 'read to it');
  const { readAt: _r, ...legacy } = { ...base, messages: [msg('a', 1)] };
  assert.equal(isUnread(legacy), false, 'a session never shown to a reader reads as read, not as all unread at once');
  assert.equal(createSession().readAt, undefined, 'core knows nothing of it: tracking starts when a reader is first shown the session');
});

test('the first mark starts tracking a session that had none', async () => {
  const { readAt: _r, ...fresh } = { ...createSession(), createdAt: at(0), messages: [msg('u', 1)] };
  const { store, docs } = casStore(fresh as Session);
  const [tool] = makeSessionTools(store, { run: () => undefined });
  await call(tool!, { action: 'get', sessionId: fresh.id, markRead: true });
  await settle();
  assert.equal(docs.get(fresh.id)!.readAt, at(1));
});

test('prompting outranks running, which outranks unread', () => {
  const unread = { ...createSession(), createdAt: at(0), readAt: at(0), messages: [msg('a', 1)] };
  assert.equal(sessionIndicator(unread), 'unread');
  assert.equal(sessionIndicator(unread, { busy: true, prompting: false }), 'running');
  assert.equal(sessionIndicator(unread, { busy: true, prompting: true }), 'prompting');
  assert.equal(sessionIndicator({ ...unread, readAt: at(1) }, { busy: false, prompting: false }), undefined);
});

test('list reports each session\'s state, and get with markRead clears unread to what it returned', async () => {
  const read   = { ...createSession(), createdAt: at(0), readAt: at(2), messages: [msg('r', 1)] };
  const unread = { ...createSession(), createdAt: at(0), readAt: at(0), messages: [msg('u', 1)] };
  const { store, docs } = casStore(read, unread);
  const [tool] = makeSessionTools(store, { run: () => undefined });

  const rows = await call(tool!, { action: 'list' }) as SessionSummary[];
  assert.equal(rows.find(r => r.id === read.id)?.state, undefined);
  assert.equal(rows.find(r => r.id === unread.id)?.state, 'unread');

  await call(tool!, { action: 'get', sessionId: unread.id });
  await settle();
  assert.equal(docs.get(unread.id)!.readAt, at(0), 'a plain get is not a reader being shown it');

  await call(tool!, { action: 'get', sessionId: unread.id, markRead: true });
  await settle();
  assert.equal(docs.get(unread.id)!.readAt, at(1));
  assert.equal(docs.get(unread.id)!.updatedAt, at(1), 'marking read is not activity: updatedAt stays on the last message');
  const after = await call(tool!, { action: 'list' }) as SessionSummary[];
  assert.equal(after.find(r => r.id === unread.id)?.state, undefined);
});

test('a mark waiting behind a running turn reads to what was returned, not to the reply it never showed', async () => {
  const session = { ...createSession(), createdAt: at(0), readAt: at(0), messages: [msg('u', 1)] };
  const { store, docs } = casStore(session);
  const { run, endTurn } = heldRunner(session.id);
  const [tool] = makeSessionTools(store, { run: () => run });

  await call(tool!, { action: 'get', sessionId: session.id, markRead: true });
  await endTurn(() => {
    const cur = docs.get(session.id)!;
    docs.set(session.id, { ...cur, version: crypto.randomUUID(), messages: [...cur.messages, msg('reply', 5)] });
  });
  await settle();
  assert.equal(docs.get(session.id)!.readAt, at(1));
  assert.equal(isUnread(docs.get(session.id)!), true, 'the turn\'s reply is still unread');
});

test('a mark never moves read backwards', async () => {
  const session = { ...createSession(), createdAt: at(0), readAt: at(9), messages: [msg('u', 1)] };
  const { store, docs } = casStore(session);
  const [tool] = makeSessionTools(store, { run: () => undefined });
  const version = session.version;
  await call(tool!, { action: 'get', sessionId: session.id, markRead: true });
  await settle();
  assert.equal(docs.get(session.id)!.readAt, at(9));
  assert.equal(docs.get(session.id)!.version, version, 'nothing to write, so nothing written');
});

test('the runner reports a session as prompting while a turn waits on an answer', { timeout: 15000 }, async () => {
  const session = createSession();
  const { store } = casStore(session);
  let asked: () => void = () => {};
  const askedP = new Promise<void>(r => { asked = r; });
  const askTool: Tool = {
    name: 'ask', description: 'asks', inputSchema: { type: 'object' },
    executor: {
      async *execute(_input: unknown, ctx: ToolContext) {
        const answer = await ctx.prompt('well?');
        yield { type: 'result', value: answer };
      },
    },
  };
  const tools = {
    register: () => {}, remove: () => {}, resolve: (n: string) => n === 'ask' ? askTool : null,
    list: () => [askTool], removeByPlugin: () => {}, watch: async function* () {},
  } as unknown as ToolRegistry;
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const n = calls++;
      return (async function* () {
        if (n === 0) yield { type: 'tool-call', id: 'c1', name: 'ask', input: {} };
        else         yield { type: 'text-delta', delta: 'done' };
        yield { type: 'done' };
      })();
    },
  };
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const runner: SessionRunner = createSessionRunner({
    store, tools,
    resolveProvider: async () => ({ adapter, config }),
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });

  let answer: (a: string) => void = () => {};
  const prompt = ((): Promise<string> => { asked(); return new Promise<string>(r => { answer = r; }); }) as PromptFn;
  const view = await runAs(principal, () => runner.open({
    sessionId: session.id, signal: new AbortController().signal, content: [{ type: 'text', text: 'go' }],
    provider: 'fake', principal, prompt,
  }));
  const idle = (async () => { for await (const ev of view.events) if (ev.type === 'idle') break; })();

  assert.equal(runner.status(session.id).prompting, false);
  await askedP;
  assert.equal(runner.status(session.id).prompting, true);
  answer('yes');
  await idle;
  assert.equal(runner.status(session.id).prompting, false);
});
