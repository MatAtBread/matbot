import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, machineBusy, quiesced, runAs,
  casAtEdge, tryCurrentPrincipal,
} from '@matatbread/matbot-core';
import type {
  MatbotMachine, Message, Session, Store, Tool, ToolContext, ToolRegistry, ProviderAdapter, ProviderConfig,
  CompletionEvent, Principal, MessageContent,
} from '@matatbread/matbot-core';
import { makeSessionTools } from '@matatbread/matbot-sessions';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';
import { plugin as editSessionPlugin } from '../../../plugins/edit-session/src/index.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// A running turn owns its session document: the runner writes its in-memory copy back unconditionally
// when the turn ends. So an edit that CASes the stored document mid-turn succeeds — and is then silently
// undone by that write-back. `session_action` rename/hide/unhide did exactly that (the web sidebar calls
// them from outside any turn), and `session_edit` deferred only for the CALLER's own session, so an edit
// of a different session that was mid-turn met the same end. Both now defer to the quiescent edge
// whenever a turn is running in the target.

const principal: Principal = { id: 'tester', type: 'user' };

function casStore(seed: Session): { store: Store<Session>; docs: Map<string, Session> } {
  const docs = new Map<string, Session>([[seed.id, seed]]);
  const store: Store<Session> = {
    get: async id => docs.get(id) ?? null,
    set: async (id, v) => { docs.set(id, v); },
    cas: async (id, expected, next) => {
      const cur = docs.get(id);
      if (!cur || cur.version !== expected) return { ok: false as const, doc: cur ?? null };
      docs.set(id, next);
      return { ok: true as const, doc: next };
    },
    delete: async id => docs.delete(id),
    query: async () => ({ items: [...docs.values()] }),
  } as unknown as Store<Session>;
  return { store, docs };
}

const emptyTools = {
  register: () => { throw new Error('register unused'); },
  unregister: () => { throw new Error('unregister unused'); },
  resolve: () => null,
  list: () => [],
  has: () => false,
} as unknown as ToolRegistry;

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

async function drain(tool: Tool, input: unknown, ctx: ToolContext): Promise<Array<{ type: string; value?: unknown; message?: string }>> {
  return runAs(principal, async () => {
    const events: Array<{ type: string; value?: unknown; message?: string }> = [];
    for await (const ev of tool.executor.execute(input, ctx)) events.push(ev as never);
    return events;
  });
}

test('a rename of a session mid-turn is deferred past the turn\'s write-back, not undone by it', { timeout: 15000 }, async () => {
  const session = { ...createSession(), title: 'before' };
  const { store, docs } = casStore(session);

  // A turn that stays open until released, so the rename lands while the runner holds its copy.
  let entered!: () => void;
  const inTurn = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      return (async function* () {
        entered();
        await gate;
        yield { type: 'text-delta', delta: 'answer' };
        yield { type: 'done' };
      })();
    },
  };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config: { name: 'fake', module: 'fake', model: 'fake' } as ProviderConfig }),
    tools:           emptyTools,
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });
  const tool = makeSessionTools(store, { busy: id => runner.status(id).busy }).find(t => t.name === 'session_action')!;

  const view = await runner.open({
    sessionId: session.id, signal: new AbortController().signal,
    content: text('go'), provider: 'fake', principal,
  });
  await inTurn;

  const events = await drain(tool, { action: 'rename', sessionId: session.id, title: 'after' }, {} as ToolContext);
  assert.deepEqual(events.find(e => e.type === 'result')?.value, { id: session.id, title: 'after', deferred: true });
  assert.equal(docs.get(session.id)!.title, 'before', 'nothing is written while the turn owns the document');

  release();
  for await (const ev of view.events) if (ev.type === 'idle') break;
  await quiesced();

  const after = docs.get(session.id)!;
  assert.equal(after.title, 'after', 'the rename survived the turn');
  assert.equal(after.messages.filter(m => m.role === 'assistant').length, 1, 'and so did the turn');
});

test('a rename of an idle session is applied at once', async () => {
  const session = { ...createSession(), title: 'before' };
  const { store, docs } = casStore(session);
  const tool = makeSessionTools(store, { busy: () => false }).find(t => t.name === 'session_action')!;

  const events = await drain(tool, { action: 'hide', sessionId: session.id }, {} as ToolContext);
  assert.deepEqual(events.find(e => e.type === 'result')?.value, { id: session.id, status: 'archived' });
  assert.equal(docs.get(session.id)!.status, 'archived');
});

test('session_edit defers an edit of ANOTHER session that has a turn running in it', { timeout: 15000 }, async () => {
  const msg = (id: string, role: Message['role']): Message =>
    ({ id, role, content: [{ type: 'text', text: id }], createdAt: new Date(0).toISOString(), traceId: 't' }) as Message;
  const target: Session = { ...createSession(), id: 'target', messages: [msg('m1', 'user'), msg('m2', 'assistant'), msg('m3', 'user')] };
  const { store, docs } = casStore(target);

  const tools = new Map<string, Tool>();
  const services = {
    sessions: store,
    isSubAgent: () => false,
    tools:    { register: (t: Tool) => { tools.set(t.name, t); } },
    run:      { status: (id: string) => ({ busy: id === 'target', running: id === 'target', queued: 0 }) },
  } as unknown as MatbotMachine;
  await editSessionPlugin.setup!(services);
  const tool = tools.get('session_edit')!;
  const ctx = { callId: 'c1', signal: new AbortController().signal, session: { id: 'caller', messages: [] } } as unknown as ToolContext;

  // Holding the machine stands in for the target's running turn: the edge cannot arrive until it ends.
  await machineBusy(async () => {
    const events = await drain(tool, { action: 'cut', sessionId: 'target', msgIndex: 2 }, ctx);
    const result = events.find(e => e.type === 'result')?.value as { deferred?: boolean; message?: string };
    assert.equal(result.deferred, true, JSON.stringify(events));
    assert.match(result.message ?? '', /a turn is running in it/);
    assert.equal(docs.get('target')!.messages.length, 3, 'nothing is written while the turn owns it');
  });
  await quiesced();

  assert.deepEqual(docs.get('target')!.messages.map(m => m.id), ['m1', 'm2'], 'the cut landed once the turn ended');
});

test('in a background job, session_edit refuses to edit a session but still forks one', async () => {
  const msg = (id: string, role: Message['role']): Message =>
    ({ id, role, content: [{ type: 'text', text: id }], createdAt: new Date(0).toISOString(), traceId: 't' }) as Message;
  const target: Session = { ...createSession(), id: 'target', messages: [msg('m1', 'user'), msg('m2', 'assistant')] };
  const { store, docs } = casStore(target);
  const tools = new Map<string, Tool>();
  const services = {
    sessions:   store,
    isSubAgent: () => true,
    tools:      { register: (t: Tool) => { tools.set(t.name, t); } },
  } as unknown as MatbotMachine;
  await editSessionPlugin.setup!(services);
  const ctx = { callId: 'c1', signal: new AbortController().signal, session: { id: 'job', messages: [] } } as unknown as ToolContext;

  // A job's store is its parent's medium, written by none of the parent's turns.
  const cut = await drain(tools.get('session_edit')!, { action: 'cut', sessionId: 'target', msgIndex: 1 }, ctx);
  assert.match(cut.find(e => e.type === 'error')?.message ?? '', /background job cannot cut/);
  assert.equal(docs.get('target')!.messages.length, 2);

  const fork = await drain(tools.get('session_edit')!, { action: 'fork', sessionId: 'target', msgIndex: 1 }, ctx);
  assert.equal(fork.find(e => e.type === 'error'), undefined, 'fork writes a session no turn can be running in');
  assert.equal(tools.has('compact_sessions'), false, 'bulk compaction is not offered to a job at all');
});

// A deferred edit addressed its position by index, on the grounds that a running turn only appends. A
// parallel reply breaks that: its pair is placed AHEAD of the running turn's own messages, so by the edge
// every later index has shifted by two, and a cut issued earlier in the turn landed two messages early —
// here, through the middle of the pair, leaving its question unanswered.
test('a deferred cut lands on the message it named, though a parallel pair was placed ahead of it', { timeout: 15000 }, async () => {
  const msg = (id: string, role: Message['role']): Message =>
    ({ id, role, content: [{ type: 'text', text: id }], createdAt: new Date(0).toISOString(), traceId: 't' }) as Message;
  // m3 is the running turn's request and m4 its answer so far; the cut drops the answer.
  const target: Session = { ...createSession(), id: 'target', messages: [msg('m1', 'user'), msg('m2', 'assistant'), msg('m3', 'user'), msg('m4', 'assistant')] };
  const { store, docs } = casStore(target);

  const tools = new Map<string, Tool>();
  const services = {
    sessions: store,
    isSubAgent: () => false,
    tools:    { register: (t: Tool) => { tools.set(t.name, t); } },
    run:      { status: (id: string) => ({ busy: id === 'target', running: id === 'target', queued: 0 }) },
  } as unknown as MatbotMachine;
  await editSessionPlugin.setup!(services);
  const tool = tools.get('session_edit')!;
  const ctx = { callId: 'c1', signal: new AbortController().signal, session: { id: 'caller', messages: [] } } as unknown as ToolContext;

  await machineBusy(async () => {
    const events = await drain(tool, { action: 'cut', sessionId: 'target', msgIndex: 3 }, ctx);
    assert.equal((events.find(e => e.type === 'result')?.value as { deferred?: boolean }).deferred, true, JSON.stringify(events));
    // The turn commits with a parallel pair placed ahead of its own messages.
    const cur = docs.get('target')!;
    docs.set('target', { ...cur, version: crypto.randomUUID(), messages: [msg('m1', 'user'), msg('m2', 'assistant'), msg('q', 'user'), msg('a', 'assistant'), msg('m3', 'user'), msg('m4', 'assistant')] });
  });
  await quiesced();

  assert.deepEqual(docs.get('target')!.messages.map(m => m.id), ['m1', 'm2', 'q', 'a', 'm3'], 'cut at the message it named');
});

test('a deferred edit whose message has gone is not applied somewhere else', { timeout: 15000 }, async () => {
  const msg = (id: string, role: Message['role']): Message =>
    ({ id, role, content: [{ type: 'text', text: id }], createdAt: new Date(0).toISOString(), traceId: 't' }) as Message;
  const target: Session = { ...createSession(), id: 'target', messages: [msg('m1', 'user'), msg('m2', 'assistant'), msg('m3', 'user'), msg('m4', 'assistant')] };
  const { store, docs } = casStore(target);
  const tools = new Map<string, Tool>();
  const services = {
    sessions: store,
    isSubAgent: () => false,
    tools:    { register: (t: Tool) => { tools.set(t.name, t); } },
    run:      { status: (id: string) => ({ busy: id === 'target', running: id === 'target', queued: 0 }) },
  } as unknown as MatbotMachine;
  await editSessionPlugin.setup!(services);
  const ctx = { callId: 'c1', signal: new AbortController().signal, session: { id: 'caller', messages: [] } } as unknown as ToolContext;

  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await machineBusy(async () => {
      await drain(tools.get('session_edit')!, { action: 'cut', sessionId: 'target', msgIndex: 3 }, ctx);
      // A retract popped the answer the cut was aimed at.
      const cur = docs.get('target')!;
      docs.set('target', { ...cur, version: crypto.randomUUID(), messages: cur.messages.slice(0, 3) });
    });
    await quiesced();
  } finally {
    console.error = error;
  }
  assert.deepEqual(docs.get('target')!.messages.map(m => m.id), ['m1', 'm2', 'm3'], 'left alone');
  assert.ok(errors.some(e => /no longer in the session/.test(e)), errors.join('\n'));
});

// The appender, `session_action` and `session_edit` each wrote "once at the edge, as the caller, reading
// again on a lost compare-and-swap" for themselves; it is core's `casAtEdge` now.
test('casAtEdge writes at the edge as the caller, and reads again when it loses', { timeout: 10000 }, async () => {
  const seen: Array<string | undefined> = [];
  let tries = 0;
  await machineBusy(async () => {
    await runAs(principal, async () => {
      casAtEdge(async () => { seen.push(tryCurrentPrincipal()?.id); return ++tries === 2; }, 'lost');
    });
    await Promise.resolve();
    assert.equal(tries, 0, 'nothing runs while the machine is held');
  });
  await quiesced();
  assert.equal(tries, 2, 'read again after the first loss, and stopped once it landed');
  assert.deepEqual(seen, ['tester', 'tester'], 'as the principal in force when it was queued');
});

test('casAtEdge reports a write lost to every attempt', { timeout: 10000 }, async () => {
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let tries = 0;
  try {
    casAtEdge(async () => { tries++; return false; }, 'the write was lost');
    await quiesced();
  } finally {
    console.error = error;
  }
  assert.equal(tries, 3);
  assert.deepEqual(errors, ['the write was lost']);
});

// session_edit's deferred edits made one compare-and-swap and gave up. At the edge the other writer is
// another flusher (an append, a rename), so a cut was dropped merely for landing beside one. Through
// casAtEdge it reads again, re-finds its anchor, and lands.
test('a deferred cut that loses its compare-and-swap at the edge is retried, not dropped', { timeout: 15000 }, async () => {
  const msg = (id: string, role: Message['role']): Message =>
    ({ id, role, content: [{ type: 'text', text: id }], createdAt: new Date(0).toISOString(), traceId: 't' }) as Message;
  const target: Session = { ...createSession(), id: 'target', messages: [msg('m1', 'user'), msg('m2', 'assistant'), msg('m3', 'user')] };
  const { store, docs } = casStore(target);
  // Another flusher lands between the edit's read and its write: an append, once.
  let raced = false;
  const racing = {
    ...store,
    cas: async (id: string, expected: string, next: Session) => {
      if (!raced) {
        raced = true;
        const cur = docs.get(id)!;
        docs.set(id, { ...cur, version: crypto.randomUUID(), messages: [...cur.messages, msg('appended', 'assistant')] });
      }
      return store.cas(id, expected, next);
    },
  } as Store<Session>;

  const tools = new Map<string, Tool>();
  const services = {
    sessions: racing,
    isSubAgent: () => false,
    tools:    { register: (t: Tool) => { tools.set(t.name, t); } },
    run:      { status: (id: string) => ({ busy: id === 'target', running: id === 'target', queued: 0 }) },
  } as unknown as MatbotMachine;
  await editSessionPlugin.setup!(services);
  const ctx = { callId: 'c1', signal: new AbortController().signal, session: { id: 'caller', messages: [] } } as unknown as ToolContext;

  await machineBusy(async () => {
    await drain(tools.get('session_edit')!, { action: 'cut', sessionId: 'target', msgIndex: 2 }, ctx);
  });
  await quiesced();

  assert.ok(raced, 'the first write lost');
  assert.deepEqual(docs.get('target')!.messages.map(m => m.id), ['m1', 'm2'], 'and the cut landed on the re-read');
});
