import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, onContextQuiesce, quiesced, runAs,
  tryCurrentPrincipal,
} from '@matatbread/matbot-core';
import type {
  Session, Store, ProviderAdapter, ProviderConfig, CompletionEvent, Message, MessageContent, Principal,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// The runner is each session's one writer. A turn works on an in-memory copy of its session and writes it
// back whole when it ends, so `SessionRunner.write` runs a write between that session's turns — and only
// that session's: writes used to wait for the machine's quiescent edge, i.e. for every turn on the machine,
// and raised a machine-wide barrier while they waited.

const principal: Principal = { id: 'tester', type: 'user' };
const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };

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

function gate(): { open: () => void; wait: Promise<void> } {
  let open = (): void => {};
  const wait = new Promise<void>(r => { open = r; });
  return { open, wait };
}

const textOf = (m: Pick<Message, 'content'>): string =>
  m.content.filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text').map(c => c.text).join(' ');

// A turn whose first provider call waits until released, so a test can act while it holds its session.
// Every call records the history it was sent.
function setup(...seed: Session[]) {
  const { store, docs } = casStore(...seed);
  const holds = new Map<string, { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> }>();
  const seen: Message[][] = [];
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      seen.push(messages);
      const hold = holds.get(textOf(messages.findLast(m => m.role === 'user') ?? { content: [] }));
      return (async function* () {
        if (hold) { hold.entered.open(); await hold.release.wait; }
        yield { type: 'text-delta', delta: 'answer' };
        yield { type: 'done' };
      })();
    },
  };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config }),
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });
  const submit = (sessionId: string, text: string) => runAs(principal, () => runner.open({
    sessionId, signal: new AbortController().signal, content: [{ type: 'text', text }], provider: 'fake', principal,
  }));
  // Submits `text` to `sessionId` and resolves once its turn is inside its provider call.
  const holdTurn = async (sessionId: string, text: string) => {
    const hold = { entered: gate(), release: gate() };
    holds.set(text, hold);
    const view = await submit(sessionId, text);
    await hold.entered.wait;
    const idle = (async () => { for await (const ev of view.events) if (ev.type === 'idle') break; })();
    return { release: hold.release.open, idle };
  };
  return { store, docs, seen, runner, submit, holdTurn };
}

// Appends a marker message by compare-and-swap, as a write's attempt would.
const appendMarker = (store: Store<Session>, sessionId: string, id: string) => async (): Promise<boolean> => {
  const cur = await store.get(sessionId);
  if (!cur) return true;
  const next = { ...cur, version: crypto.randomUUID(), messages: [...cur.messages, { id, role: 'marker', content: [], createdAt: new Date().toISOString(), traceId: 'w' } as Message] };
  return (await store.cas(sessionId, cur.version, next)).ok;
};

test('a write of an idle session is made at once, and a submission arriving meanwhile reads what it wrote', { timeout: 10000 }, async () => {
  const session = createSession();
  const { store, docs, seen, runner, submit } = setup(session);

  const write = runner.write(session.id, appendMarker(store, session.id, 'w1'), 'lost');
  assert.equal(write.deferred, false);
  const view = await submit(session.id, 'hello');
  for await (const ev of view.events) if (ev.type === 'idle') break;
  await write.done;

  assert.deepEqual(docs.get(session.id)!.messages.map(m => m.id === 'w1' ? 'w1' : m.role), ['w1', 'user', 'assistant']);
  assert.ok(seen[0]!.some(m => m.id === 'w1'), 'the turn ran on the written document, not under the write');
});

test('a write during a turn waits for it, survives its write-back, and is read by the next turn', { timeout: 10000 }, async () => {
  const session = createSession();
  const { store, docs, seen, runner, submit, holdTurn } = setup(session);

  const turn = await holdTurn(session.id, 'first');
  const write = runner.write(session.id, appendMarker(store, session.id, 'w1'), 'lost');
  assert.equal(write.deferred, true, 'a turn holds the session');
  const next = await submit(session.id, 'second');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(!docs.get(session.id)!.messages.some(m => m.id === 'w1'), 'nothing written while the turn holds its copy');

  turn.release();
  for await (const ev of next.events) if (ev.type === 'idle') break;
  await write.done;

  assert.deepEqual(docs.get(session.id)!.messages.map(m => m.id === 'w1' ? 'w1' : textOf(m)),
    ['first', 'answer', 'w1', 'second', 'answer'], 'after the turn it waited for, before the one queued behind it');
  assert.ok(seen.at(-1)!.some(m => m.id === 'w1'), 'the next turn read it');
});

// The point of moving writes off the machine edge: another session's turn — however long, and a parallel
// turn or an in-process job can be long — no longer holds them back, and they no longer bar new turns.
test('a write waits only for its own session\'s turns, and bars no other session\'s', { timeout: 10000 }, async () => {
  const busy = createSession();
  const idle = createSession();
  const other = createSession();
  const { store, docs, runner, submit, holdTurn } = setup(busy, idle, other);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    const turn = await holdTurn(busy.id, 'long');

    const ofIdle = runner.write(idle.id, appendMarker(store, idle.id, 'w-idle'), 'lost');
    assert.equal(ofIdle.deferred, false);
    await ofIdle.done;
    assert.ok(docs.get(idle.id)!.messages.some(m => m.id === 'w-idle'), 'landed while the other session\'s turn ran');

    // A write that does wait, for its own session's turn, holds nobody else up.
    const ofBusy = runner.write(busy.id, appendMarker(store, busy.id, 'w-busy'), 'lost');
    assert.equal(ofBusy.deferred, true);
    const t0 = Date.now();
    const view = await submit(other.id, 'meanwhile');
    for await (const ev of view.events) if (ev.type === 'idle') break;
    assert.ok(Date.now() - t0 < 1000, `a third session's turn ran at once (${Date.now() - t0}ms)`);
    assert.ok(!warnings.some(w => w.includes('entering the machine after waiting')), 'and met no barrier');

    turn.release();
    await turn.idle;
    await ofBusy.done;
    assert.ok(docs.get(busy.id)!.messages.some(m => m.id === 'w-busy'));
  } finally {
    console.warn = warn;
  }
});

test('writes of one session run one at a time, in order, as the principal in force when each was made', { timeout: 10000 }, async () => {
  const session = createSession();
  const { store, docs, runner, holdTurn } = setup(session);
  const turn = await holdTurn(session.id, 'first');

  const order: string[] = [];
  const as: Array<string | undefined> = [];
  const writes = ['a', 'b', 'c'].map(id => runAs({ id: `user-${id}`, type: 'user' }, () =>
    runner.write(session.id, async () => {
      order.push(`${id}:start`);
      as.push(tryCurrentPrincipal()?.id);
      await new Promise(r => setTimeout(r, 5));
      const ok = await appendMarker(store, session.id, id)();
      order.push(`${id}:end`);
      return ok;
    }, 'lost')));
  turn.release();
  await Promise.all(writes.map(w => w.done));

  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  assert.deepEqual(as, ['user-a', 'user-b', 'user-c']);
  assert.deepEqual(docs.get(session.id)!.messages.filter(m => m.role === 'marker').map(m => m.id), ['a', 'b', 'c']);
});

test('a write never starts before write() returns', async () => {
  const session = createSession();
  const { runner } = setup(session);
  let started = false;
  const write = runner.write(session.id, async () => { started = true; return true; }, 'lost');
  assert.equal(started, false);
  await write.done;
  assert.equal(started, true);
});

test('a lost compare-and-swap is read again; one lost every time is logged; a throw is logged and the next write still runs', { timeout: 10000 }, async () => {
  const session = createSession();
  const { runner } = setup(session);
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    let tries = 0;
    await runner.write(session.id, async () => ++tries === 2, 'not this one').done;
    assert.equal(tries, 2, 'read again after the first loss, and stopped once it landed');

    let always = 0;
    await runner.write(session.id, async () => { always++; return false; }, 'the write was lost').done;
    assert.equal(always, 3);

    const thrown = runner.write(session.id, async () => { throw new Error('boom'); }, 'lost');
    let after = false;
    const next = runner.write(session.id, async () => { after = true; return true; }, 'lost');
    await thrown.done;      // never rejects
    await next.done;
    assert.ok(after, 'the write after the throw ran');
  } finally {
    console.error = error;
  }
  assert.ok(errors.includes('the write was lost'));
  assert.ok(!errors.includes('not this one'));
  assert.ok(errors.some(e => e.includes('boom')), errors.join('\n'));
});

// Machine-wide work still waits for every turn: a staged storage swap must not land under a write either.
test('writes leave machine work to the edge, and run inside the hold', { timeout: 10000 }, async () => {
  const session = createSession();
  const { store, runner, holdTurn } = setup(session);
  const turn = await holdTurn(session.id, 'first');
  let landed = false;
  onContextQuiesce(un => { un(); landed = true; });
  let landedDuringWrite: boolean | undefined;
  const write = runner.write(session.id, async () => { landedDuringWrite = landed; return appendMarker(store, session.id, 'w')(); }, 'lost');
  turn.release();
  await write.done;
  await turn.idle;
  await quiesced();
  assert.equal(landedDuringWrite, false, 'the staged work did not land under the write');
  assert.equal(landed, true, 'it landed once the queue drained');
});

test('a write that arrives while the pump writes another is not left behind', { timeout: 10000 }, async () => {
  const session = createSession();
  const { store, docs, runner } = setup(session);
  let second: { done: Promise<void> } | undefined;
  const first = runner.write(session.id, async () => {
    // Arrives while the pump is inside this write.
    second ??= runner.write(session.id, appendMarker(store, session.id, 'second'), 'lost');
    return appendMarker(store, session.id, 'first')();
  }, 'lost');
  await first.done;
  await second!.done;
  assert.deepEqual(docs.get(session.id)!.messages.map(m => m.id), ['first', 'second']);
  for (let i = 0; i < 100 && runner.status(session.id).busy; i++) await new Promise(r => setImmediate(r));
  assert.equal(runner.status(session.id).busy, false, 'and the pump went idle with nothing left');
});

