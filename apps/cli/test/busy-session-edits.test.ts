import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, machineBusy, quiesced, runAs,
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
