import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, withFailure } from '@matatbread/matbot-core';
import type {
  Session, Store, ProviderAdapter, ProviderConfig, CompletionEvent, PipelineEvent, Principal, SessionRunner,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '@matatbread/matbot-host-node';
import { createAlsUsageCarrier } from '@matatbread/matbot-host-node';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// The pump runs detached, so a store failure inside it had nowhere to go but an unhandled rejection, which
// under node's default exits the process — every turn on every session with it (issue #115). And the turn
// it had taken off the queue simply vanished: no terminal event, nothing to say it was not sent.
//
// A failure is now that turn's `error`, carrying whatever class the store gave it, and the session goes on.

const principal: Principal = { id: 'tester', type: 'user' };
const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };

// The socket a keep-alive connection had closed under the request, as undici reports it.
const socketClosed = (): Error => new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }) });

interface Faults { get?: (doc: Session | undefined) => Error | undefined; set?: (doc: Session) => Error | undefined }

function faultyStore(seed: Session, faults: Faults): { store: Store<Session>; docs: Map<string, Session>; gets: () => number } {
  const docs = new Map<string, Session>([[seed.id, seed]]);
  let gets = 0;
  const store: Store<Session> = {
    get: async id => { gets++; const e = faults.get?.(docs.get(id)); if (e) throw e; return docs.get(id) ?? null; },
    set: async (id, v) => { const e = faults.set?.(v); if (e) throw e; docs.set(id, v); },
    cas: async (id, expected, next) => {
      const cur = docs.get(id) ?? null;
      if (cur === null || cur.version !== expected) return { ok: false, current: cur };
      docs.set(id, next);
      return { ok: true, doc: next };
    },
    delete: async () => { throw new Error('delete unused'); },
    query: async () => { throw new Error('query unused'); },
  };
  return { store, docs, gets: () => gets };
}

const adapter: ProviderAdapter = {
  name: 'fake',
  async health() { return { ok: true } as never; },
  complete(): AsyncIterable<CompletionEvent> {
    return (async function* () {
      yield { type: 'text-delta', delta: 'answered' };
      yield { type: 'usage', inputTokens: 3, outputTokens: 1 };
      yield { type: 'done' };
    })();
  },
};

function runnerOver(store: Store<Session>): SessionRunner {
  return createSessionRunner({ store, resolveProvider: async () => ({ adapter, config }) });
}

// Every unhandled rejection while `fn` runs, and a settle afterwards for any that arrive late.
async function rejectionsDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const on = (e: unknown): void => { seen.push(e); };
  process.on('unhandledRejection', on);
  try {
    await fn();
    await new Promise(r => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', on);
  }
  return seen;
}

async function untilIdle(view: { events: AsyncIterable<PipelineEvent> }): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; }
  return events;
}

const submit = (runner: SessionRunner, sessionId: string, text: string) =>
  runner.open({ sessionId, signal: new AbortController().signal, content: [{ type: 'text', text }], provider: 'fake', principal });

const userTexts = (s: Session): string[] =>
  s.messages.filter(m => m.role === 'user').map(m => m.content.map(c => (c.type === 'text' ? c.text : '')).join(''));

test("a failed read at a turn's start ends that turn with an error, and the session goes on", { timeout: 10000 }, async () => {
  const session = createSession();
  let fail = true;
  const { store, docs } = faultyStore(session, { get: () => (fail ? (fail = false, socketClosed()) : undefined) });
  const runner = runnerOver(store);

  let events: PipelineEvent[] = [];
  let first: { traceId: string } | undefined;
  const rejections = await rejectionsDuring(async () => {
    const view = await submit(runner, session.id, 'one');
    first = view;
    events = await untilIdle(view);
  });

  assert.deepEqual(rejections, [], 'nothing escaped the pump');
  const err = events.find(e => e.type === 'error');
  assert.ok(err && err.type === 'error' && err.traceId === first!.traceId, `the turn ended with an error of its own: ${JSON.stringify(events)}`);
  assert.match(err.error, /fetch failed/);
  assert.match(err.error, /other side closed/, 'the cause is reported, not dropped');
  assert.equal(err.failure, undefined, 'the store did not say whether it was temporary, so it is not guessed');
  assert.deepEqual(userTexts(docs.get(session.id)!), [], 'nothing of the failed turn was written');
  assert.equal(runner.status(session.id).busy, false);

  const again = await untilIdle(await submit(runner, session.id, 'two'));
  assert.ok(again.some(e => e.type === 'done'), 'the next submission runs');
  assert.deepEqual(userTexts(docs.get(session.id)!), ['two']);
});

test("a store's class reaches the turn's error", { timeout: 10000 }, async () => {
  const session = createSession();
  let fail = true;
  const { store } = faultyStore(session, { get: () => (fail ? (fail = false, withFailure(socketClosed(), 'unavailable')) : undefined) });
  const runner = runnerOver(store);

  const events = await untilIdle(await submit(runner, session.id, 'one'));
  const err = events.find(e => e.type === 'error');
  assert.ok(err && err.type === 'error');
  assert.equal(err.failure, 'unavailable');
});

test("a failed write of the turn's user message ends that turn with an error", { timeout: 10000 }, async () => {
  const session = createSession();
  let fail = true;
  const { store, docs } = faultyStore(session, { set: () => (fail ? (fail = false, socketClosed()) : undefined) });
  const runner = runnerOver(store);

  let events: PipelineEvent[] = [];
  const rejections = await rejectionsDuring(async () => { events = await untilIdle(await submit(runner, session.id, 'one')); });

  assert.deepEqual(rejections, []);
  assert.ok(events.some(e => e.type === 'error'), JSON.stringify(events));
  assert.ok(!events.some(e => e.type === 'done'), 'the turn did not run on a session it could not write');
  assert.deepEqual(userTexts(docs.get(session.id)!), []);
  assert.ok((await untilIdle(await submit(runner, session.id, 'two'))).some(e => e.type === 'done'));
});

test('a failed usage flush is logged, not thrown', { timeout: 10000 }, async () => {
  const session = createSession();
  // The only read after the turn has committed (there are no hooks) is the flush's.
  const { store, docs } = faultyStore(session, { get: doc => (doc?.messages.some(m => m.role === 'assistant') ? socketClosed() : undefined) });
  const runner = runnerOver(store);

  let events: PipelineEvent[] = [];
  const rejections = await rejectionsDuring(async () => { events = await untilIdle(await submit(runner, session.id, 'one')); });

  assert.deepEqual(rejections, []);
  assert.ok(events.some(e => e.type === 'done'), 'the turn itself succeeded');
  assert.ok(docs.get(session.id)!.messages.some(m => m.role === 'assistant'));
  assert.equal(runner.status(session.id).busy, false);
});

// `open()` read the session back AFTER queueing the submission, to fill a `session` field no submitter
// read. A failed read made `open()` throw while the submission ran anyway — so a caller told it had failed,
// that sent it again, ran it twice.
test('a submission does not read the session, so open() never reports a submission that runs as failed', { timeout: 10000 }, async () => {
  const session = createSession();
  let fail = true;
  const { store, docs, gets } = faultyStore(session, { get: () => (fail ? (fail = false, socketClosed()) : undefined) });
  const runner = runnerOver(store);

  const view = await submit(runner, session.id, 'one');
  assert.equal('session' in view, false, 'a submission is not handed the session');
  assert.equal(typeof view.traceId, 'string');
  const events = await untilIdle(view);
  assert.ok(events.some(e => e.type === 'error' && e.traceId === view.traceId), 'the failed read is the turn\'s to report');
  assert.ok(gets() >= 1);

  await untilIdle(await submit(runner, session.id, 'one'));
  assert.deepEqual(userTexts(docs.get(session.id)!), ['one'], 'sending it again ran it once');
});

test('a submission to a session that does not exist is an invalid error on its stream', { timeout: 10000 }, async () => {
  const { store } = faultyStore(createSession(), {});
  const runner = runnerOver(store);

  const view = await submit(runner, 'nope', 'hello');
  const events = await untilIdle(view);
  const err = events.find(e => e.type === 'error');
  assert.ok(err && err.type === 'error' && err.traceId === view.traceId);
  assert.match(err.error, /Session "nope" not found/);
  assert.equal(err.failure, 'invalid');
  assert.equal(runner.status('nope').busy, false);
});
