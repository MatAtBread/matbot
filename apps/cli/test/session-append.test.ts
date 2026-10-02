import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, createSessionAppender, installPrincipalCarrier, machineBusy, quiesced, readOnlyError, runAs, SessionAppendKind,
} from '@matatbread/matbot-core';
import type { Notifier, Session, SessionAppender, Store, Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { makeSessionTools } from '@matatbread/matbot-sessions';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());

// An append adds messages to a session without running a turn — a background job's report. A running
// turn owns its session and writes its in-memory copy back whole at the end, so the append is checked at
// once (a missing session is reported to someone who can act on it) and written at the quiescent edge,
// where no turn holds any session. Then it is announced: the ItemChange the write raises says the
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

test('an append waits for the quiescent edge, then lands and says which messages arrived', { timeout: 15000 }, async () => {
  const session = createSession();
  const { store, docs } = casStore(session);
  const { notifier, seen } = recordingNotifier();
  const appender = createSessionAppender({ sessions: () => store, notifier: () => notifier, isSubAgent: () => false });

  // Holding the machine stands in for a running turn: the edge cannot arrive until it ends.
  let accepted!: { sessionId: string; messageIds: string[] };
  await machineBusy(async () => {
    accepted = await runAs(principal, () => appender.append(session.id, say('Time for the dentist.')));
    assert.equal(docs.get(session.id)!.messages.length, 0, 'accepted, but not written while a turn could own the session');
  });
  await quiesced();

  const after = docs.get(session.id)!;
  assert.deepEqual(after.messages.map(m => m.id), accepted.messageIds, 'the ids handed back at acceptance are the ones written');
  assert.equal(after.messages[0]!.role, 'assistant');
  assert.deepEqual(after.messages[0]!.content, [{ type: 'text', text: 'Time for the dentist.', origin: 'robo' }]);
  assert.deepEqual(seen, [{ kind: SessionAppendKind, source: 'append', sessionId: session.id, messageIds: accepted.messageIds, principal }]);
});

test('an append is refused at once when it cannot land, and refused outright in a background job', async () => {
  const { store } = casStore();
  const { notifier } = recordingNotifier();
  const parent = createSessionAppender({ sessions: () => store, notifier: () => notifier, isSubAgent: () => false });
  await assert.rejects(parent.append('nope', say('x')), /Session "nope" not found/);
  await assert.rejects(parent.append(undefined, say('x')), /No session was named/);

  // A job's store is its parent's medium, and none of the parent's turns pass through it.
  const job = createSessionAppender({ sessions: () => store, notifier: () => notifier, isSubAgent: () => true });
  await assert.rejects(job.append('any', say('x')), /background job/);
});

// A session shared in read-only is readable, so the append is accepted; its write is refused at the edge.
// That refusal escaped as the edge's generic "flush rejected", which never said an append had been lost.
test('an append that cannot be written at the edge says it was dropped, and announces nothing', async () => {
  const session = createSession();
  const { store } = casStore(session);
  store.cas = async () => { throw readOnlyError('sessions', session.id, 'bob'); };
  const { notifier, seen } = recordingNotifier();
  const appender = createSessionAppender({ sessions: () => store, notifier: () => notifier, isSubAgent: () => false });

  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await runAs(principal, () => appender.append(session.id, say('x')));
    await quiesced();
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

test('session_action append defaults to this conversation, and lands once nothing is running', { timeout: 15000 }, async () => {
  const session = createSession();
  const { store, docs } = casStore(session);
  const { notifier } = recordingNotifier();
  const appender = createSessionAppender({ sessions: () => store, notifier: () => notifier, isSubAgent: () => false });
  const tool = makeSessionTools(store, { appender: () => appender }).find(t => t.name === 'session_action')!;

  const events = await run(tool, { action: 'append', text: 'Noted.' }, session.id);
  const result = events.find(e => e.type === 'result')?.value as { id: string; messageIds: string[]; deferred: true };
  assert.equal(result.id, session.id, 'no sessionId ⇒ the conversation the call came from');
  assert.equal(result.deferred, true);
  await quiesced();
  assert.equal(docs.get(session.id)!.messages.length, 1);
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
