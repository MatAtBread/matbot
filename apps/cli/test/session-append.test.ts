import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, createSessionAppender, createSessionRunner, installPrincipalCarrier, installUsageCarrier, readOnlyError,
  runAs, SessionAppendKind,
} from '@matatbread/matbot-core';
import type {
  CompletionEvent, Notifier, ProviderAdapter, ProviderConfig, Session, SessionAppender, SessionRunner, Store, Tool, ToolContext,
} from '@matatbread/matbot-plugin-api';
import { makeSessionTools } from '@matatbread/matbot-sessions';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// An append adds messages to a session without running a turn — a background job's report. A running
// turn owns its session and writes its in-memory copy back whole at the end, so the append is checked at
// once (a missing session is reported to someone who can act on it) and written by the session's runner
// once no turn holds that session. Then it is announced: the ItemChange the write raises says the
// session changed; `SessionAppend` says WHICH messages arrived, which a re-read cannot.

const principal = { id: 'tester', type: 'user' as const };

function casStore(...seed: Session[]): { store: Store<Session>; docs: Map<string, Session> } {
  const docs = new Map(seed.map(s => [s.id, s]));
  const store = {
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
  return { store, docs };
}

function recordingNotifier(): { notifier: Notifier; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  return { seen, notifier: { notify: (n: unknown) => { seen.push(n as Record<string, unknown>); }, consume: () => {} } as unknown as Notifier };
}

const say = (text: string) => [{ role: 'assistant' as const, content: [{ type: 'text' as const, text, origin: 'robo' as const }] }];

// A runner over `store` whose turns wait in their provider call until released.
function runnerOver(store: Store<Session>): { runner: SessionRunner; holdTurn: (sessionId: string) => Promise<{ release: () => void; idle: Promise<void> }> } {
  let release!: () => void;
  let entered!: () => void;
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      return (async function* () {
        const held = new Promise<void>(r => { release = r; });
        entered();
        await held;
        yield { type: 'text-delta', delta: 'answer' };
        yield { type: 'done' };
      })();
    },
  };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config: { name: 'fake', module: 'fake', model: 'fake' } as ProviderConfig }),
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });
  return {
    runner,
    async holdTurn(sessionId) {
      const inTurn = new Promise<void>(r => { entered = r; });
      const view = await runAs(principal, () => runner.open({
        sessionId, signal: new AbortController().signal, content: [{ type: 'text', text: 'go' }], provider: 'fake', principal,
      }));
      await inTurn;
      return { release: () => release(), idle: (async () => { for await (const ev of view.events) if (ev.type === 'idle') break; })() };
    },
  };
}

test('an append waits for the turn holding its session, then lands and says which messages arrived', { timeout: 15000 }, async () => {
  const session = createSession();
  const { store, docs } = casStore(session);
  const { notifier, seen } = recordingNotifier();
  const { runner, holdTurn } = runnerOver(store);
  const appender = createSessionAppender({ sessions: () => store, run: () => runner, notifier: () => notifier, isSubAgent: () => false });

  const turn = await holdTurn(session.id);
  const accepted = await runAs(principal, () => appender.append(session.id, say('Time for the dentist.')));
  assert.equal(accepted.deferred, true, 'accepted while a turn holds the session');
  assert.ok(!docs.get(session.id)!.messages.some(m => accepted.messageIds.includes(m.id)), 'and not written under it');

  turn.release();
  await turn.idle;

  const after = docs.get(session.id)!;
  assert.deepEqual(after.messages.map(m => m.role), ['user', 'assistant', 'assistant'], 'written after the turn, not undone by it');
  const appended = after.messages.at(-1)!;
  assert.deepEqual([appended.id], accepted.messageIds, 'the ids handed back at acceptance are the ones written');
  assert.deepEqual(appended.content, [{ type: 'text', text: 'Time for the dentist.', origin: 'robo' }]);
  assert.deepEqual(seen.filter(n => n.kind === SessionAppendKind),
    [{ kind: SessionAppendKind, source: 'append', sessionId: session.id, messageIds: accepted.messageIds, principal }]);
});

test('an append to a session no turn holds is written before it settles', async () => {
  const session = createSession();
  const { store, docs } = casStore(session);
  const { notifier } = recordingNotifier();
  const { runner } = runnerOver(store);
  const appender = createSessionAppender({ sessions: () => store, run: () => runner, notifier: () => notifier, isSubAgent: () => false });

  const accepted = await runAs(principal, () => appender.append(session.id, say('Done.')));
  assert.equal(accepted.deferred, undefined);
  assert.deepEqual(docs.get(session.id)!.messages.map(m => m.id), accepted.messageIds);
});

test('an append is refused at once when it cannot land, and refused outright in a background job', async () => {
  const { store } = casStore();
  const { notifier } = recordingNotifier();
  const { runner } = runnerOver(store);
  const parent = createSessionAppender({ sessions: () => store, run: () => runner, notifier: () => notifier, isSubAgent: () => false });
  await assert.rejects(parent.append('nope', say('x')), /Session "nope" not found/);
  await assert.rejects(parent.append(undefined, say('x')), /No session was named/);

  // A job's store is its parent's medium, and none of the parent's turns pass through it.
  const job = createSessionAppender({ sessions: () => store, run: () => runner, notifier: () => notifier, isSubAgent: () => true });
  await assert.rejects(job.append('any', say('x')), /background job/);
});

// A session shared in read-only is readable, so the append is accepted; its write is refused. That refusal
// escaped as the edge's generic "flush rejected", which never said an append had been lost — and the caller
// had already been told it was accepted. With no turn to wait for, the caller is now told.
test('an append that cannot be written says it was dropped, to the caller when it can, and announces nothing', async () => {
  const session = createSession();
  const { store } = casStore(session);
  store.cas = async () => { throw readOnlyError('sessions', session.id, 'bob'); };
  const { notifier, seen } = recordingNotifier();
  const { runner } = runnerOver(store);
  const appender = createSessionAppender({ sessions: () => store, run: () => runner, notifier: () => notifier, isSubAgent: () => false });

  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await assert.rejects(runAs(principal, () => appender.append(session.id, say('x'))), /not written.*read-only/);
  } finally {
    console.error = error;
  }
  assert.deepEqual(seen, [], 'nothing landed, so nothing is announced');
  assert.ok(errors.some(e => e.includes(`append to session "${session.id}" dropped`) && e.includes('read-only')),
    `the log names the lost append and why: ${JSON.stringify(errors)}`);
});

async function run(tool: Tool, input: unknown, sessionId: string): Promise<Array<{ type: string; value?: unknown; message?: string }>> {
  return runAs(principal, async () => {
    const ctx = { session: { id: sessionId, messages: [] }, signal: new AbortController().signal } as unknown as ToolContext;
    const events: Array<{ type: string; value?: unknown; message?: string }> = [];
    for await (const ev of tool.executor.execute(input, ctx)) events.push(ev as never);
    return events;
  });
}

test('session_action append defaults to this conversation, and says deferred only while it waits', { timeout: 15000 }, async () => {
  const session = createSession();
  const { store, docs } = casStore(session);
  const { notifier } = recordingNotifier();
  const { runner, holdTurn } = runnerOver(store);
  const appender = createSessionAppender({ sessions: () => store, run: () => runner, notifier: () => notifier, isSubAgent: () => false });
  const tool = makeSessionTools(store, { appender: () => appender, run: () => runner }).find(t => t.name === 'session_action')!;

  const now = await run(tool, { action: 'append', text: 'Noted.' }, session.id);
  const result = now.find(e => e.type === 'result')?.value as { id: string; messageIds: string[]; deferred?: true };
  assert.equal(result.id, session.id, 'no sessionId ⇒ the conversation the call came from');
  assert.equal(result.deferred, undefined, 'nothing was running, so it is written');
  assert.equal(docs.get(session.id)!.messages.length, 1);

  const turn = await holdTurn(session.id);
  const later = await run(tool, { action: 'append', text: 'Later.' }, session.id);
  assert.equal((later.find(e => e.type === 'result')?.value as { deferred?: true }).deferred, true, 'a turn holds it');
  turn.release();
  await turn.idle;
  assert.equal(docs.get(session.id)!.messages.at(-1)!.id, (later.find(e => e.type === 'result')?.value as { messageIds: string[] }).messageIds[0]);
});

test('in a background job, append goes to the job\'s conversation and every other session write is refused', async () => {
  const session = createSession();
  const { store } = casStore(session);
  const calls: Array<string | undefined> = [];
  // What the jobs plugin registers in a job: an appender that forwards to the parent, knowing its destination.
  const forwarding: SessionAppender = {
    defaultSessionId: 'reports-here',
    append: async (sessionId, messages) => { calls.push(sessionId); return { sessionId: sessionId ?? 'reports-here', messageIds: messages.map(() => 'm') }; },
  };
  const tool = makeSessionTools(store, { appender: () => forwarding, isSubAgent: () => true }).find(t => t.name === 'session_action')!;

  // The job's own session is a throwaway one: the default is where the job reports, never that.
  const appended = await run(tool, { action: 'append', text: 'Done.' }, 'the-jobs-own-session');
  assert.equal(appended.find(e => e.type === 'error'), undefined, JSON.stringify(appended));
  assert.deepEqual(calls, ['reports-here']);

  for (const input of [
    { action: 'rename', sessionId: session.id, title: 'x' },
    { action: 'hide',   sessionId: session.id },
    { action: 'unhide', sessionId: session.id },
  ]) {
    const refused = await run(tool, input, 'the-jobs-own-session');
    assert.match(refused.find(e => e.type === 'error')?.message ?? '', /background job cannot/, JSON.stringify(input));
  }

  // A job that reports nowhere must name a session rather than post into its own.
  const nowhere = makeSessionTools(store, { appender: () => ({ append: forwarding.append }), isSubAgent: () => true })
    .find(t => t.name === 'session_action')!;
  const unnamed = await run(nowhere, { action: 'append', text: 'x' }, 'the-jobs-own-session');
  assert.match(unnamed.find(e => e.type === 'error')?.message ?? '', /reports to no conversation/);
});
