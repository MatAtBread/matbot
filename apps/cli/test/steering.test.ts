import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier } from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  Message, PipelineEvent, Principal, MessageContent, MediaStore, FileHandle, MimeType,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

// The runner scopes each turn in contextSwitch/withUsageScope, which need host carriers installed at
// boot — same as apps/cli does. Use the production ALS carriers so the two turns stay isolated.
installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// Mid-turn steering (`mode: 'interrupt'` / `'auto'`): a submission arriving while a turn runs stops
// the running turn — KEEPING its committed partial work (the tool-call + result already done) — and
// runs next with a "keep going" nudge. The subtlety this guards is the race we deliberately closed by
// deciding in-runner: the abort+unshift is atomic against pump, so the steer never lands on a later turn.

const principal: Principal = { id: 'tester', type: 'user' };

function memStore(seed: Session): Store<Session> {
  const m = new Map<string, Session>([[seed.id, seed]]);
  return {
    get: async id => m.get(id) ?? null,
    set: async (id, v) => { m.set(id, v); },
    cas: async () => { throw new Error('cas unused'); },
    delete: async () => { throw new Error('delete unused'); },
    query: async () => { throw new Error('query unused'); },
  };
}

// A tool that blocks until either released manually (normal completion) or the turn is aborted (an
// interrupt). `started` fires when execution begins, so a test can submit its steer at the exact
// mid-turn point where the runner is inside tool execution.
function slowTool(started: () => void, gate: Promise<void>): Tool {
  return {
    name: 'slow',
    description: 'blocks until released or aborted',
    inputSchema: { type: 'object' },
    executor: {
      execute(_input, ctx) {
        return (async function* () {
          started();
          await new Promise<void>(resolve => {
            if (ctx.signal.aborted) return resolve();
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
            void gate.then(() => resolve());
          });
          // Mirror a real tool aborted mid-flight (e.g. a fetch rejecting with the abort reason): throw,
          // so the abort reason would leak into the result unless the runner reframes it.
          if (ctx.signal.aborted) throw new Error(String(ctx.signal.reason));
          yield { type: 'result', value: { done: true } };
        })();
      },
    },
  };
}

function toolRegistry(tool: Tool): ToolRegistry {
  const map = new Map<string, Tool>([[tool.name, tool]]);
  return {
    register: t => { map.set(t.name, t); },
    remove: n => { map.delete(n); },
    resolve: n => map.get(n) ?? null,
    list: () => [...map.values()],
    removeByPlugin: () => {},
    watch: async function* () {},
  };
}

// call #1 → a tool-call to `slow`; every later call → a final text turn. So the interrupted turn makes
// exactly one call (tool-call, then aborted during tool exec) and the continuation makes the text call.
// `seen` captures the messages of each provider call so a test can assert the nudge was folded in.
function fakeProvider(seen: Message[][]): ProviderAdapter {
  let calls = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      seen.push(messages);
      const n = calls++;
      return (async function* () {
        if (n === 0) {
          yield { type: 'tool-call', id: 'c1', name: 'slow', input: {} };
        } else {
          yield { type: 'text-delta', delta: 'continued' };
        }
        yield { type: 'done' };
      })();
    },
  };
}

function makeRunner(store: Store<Session>, tools: ToolRegistry, adapter: ProviderAdapter, media?: MediaStore) {
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  return createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config }),
    tools,
    ...(media ? { mediaStore: () => media } : {}),
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
  });
}

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];
const roles = (s: Session): string[] => s.messages.map(m => m.role);
const textOf = (m: Message): string =>
  m.content.filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text').map(c => c.text).join(' ');

test('mode:auto interrupts the running turn, preserves the thread, and folds the nudge', { timeout: 10000 }, async () => {
  const session = createSession();
  const sid = session.id;
  const store = memStore(session);
  const seen: Message[][] = [];
  const started = { fire: () => {} };
  const startedP = new Promise<void>(r => { started.fire = r; });
  const tools = toolRegistry(slowTool(() => started.fire(), new Promise<void>(() => { /* never released; abort ends it */ })));
  const runner = makeRunner(store, tools, fakeProvider(seen));

  const view = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: text('do it'), provider: 'fake', principal });
  const events: PipelineEvent[] = [];
  const collector = (async () => { for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; } })();

  await startedP; // provider call #1 emitted the tool-call; we are now inside `slow`

  // No steering policy registered ⇒ 'auto' resolves to DEFAULT_STEERING_POLICY ('interrupt').
  await runner.open({ sessionId: sid, signal: new AbortController().signal, content: text('STEER'), provider: 'fake', principal, mode: 'auto' });
  await collector;

  // The steer was announced, and the running turn yielded via an abort tagged 'steer'.
  const steer = events.find(e => e.type === 'steer');
  assert.ok(steer && steer.type === 'steer' && textOf({ content: steer.content } as Message) === 'STEER', 'steer event with the new bubble');
  const aborted = events.find(e => e.type === 'aborted');
  assert.ok(aborted && aborted.type === 'aborted' && aborted.reason === 'steer', 'interrupted turn aborted with reason steer');

  // The thread is preserved: the committed history keeps the assistant tool-call + its tool result
  // (no dangling tool_use), then the steer user message, then the continuation.
  const final = (await store.get(sid))!;
  assert.deepEqual(roles(final), ['user', 'assistant', 'tool', 'user', 'assistant'], 'partial work kept, then steer + continuation');
  assert.equal(textOf(final.messages[3]!), 'STEER', 'steer landed as the last user turn');
  assert.equal(textOf(final.messages[4]!), 'continued', 'model continued after the steer');

  // The interrupted tool's result is reframed — the raw abort reason ('steer') never leaks to the model.
  const interruptedResult = (final.messages[2]!.content[0] as { result: { error?: string } }).result;
  assert.ok(interruptedResult.error && !/steer/i.test(interruptedResult.error), 'aborted tool result reframed, no leaked reason');
  assert.match(interruptedResult.error!, /interrupted before completion/, 'reframed to the neutral interrupted message');

  // The continuation provider call saw the ephemeral nudge folded onto the tail.
  const contMessages = seen[1]!;
  const tail = contMessages[contMessages.length - 1]!;
  assert.match(textOf(tail), /sent the message above while you were working/, 'DEFAULT_STEER_NUDGE folded into the continuation call');
});

test('default mode (queue) waits for the turn boundary — no interrupt', { timeout: 10000 }, async () => {
  const session = createSession();
  const sid = session.id;
  const store = memStore(session);
  const seen: Message[][] = [];
  const started = { fire: () => {} };
  const startedP = new Promise<void>(r => { started.fire = r; });
  let release = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const tools = toolRegistry(slowTool(() => started.fire(), gate));
  const runner = makeRunner(store, tools, fakeProvider(seen));

  const view = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: text('first'), provider: 'fake', principal });
  const events: PipelineEvent[] = [];
  const collector = (async () => { for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; } })();

  await startedP;

  // Submit with no mode ⇒ runner default 'queue' (backward-compatible): it must NOT interrupt.
  await runner.open({ sessionId: sid, signal: new AbortController().signal, content: text('second'), provider: 'fake', principal });
  const st = runner.status(sid);
  assert.ok(st.running && st.queued === 1, 'second submission queued behind the still-running turn');

  release(); // let the first turn's tool finish naturally
  await collector;

  assert.ok(!events.some(e => e.type === 'steer'), 'no steer event under queue mode');
  assert.ok(!events.some(e => e.type === 'aborted'), 'nothing aborted under queue mode');

  const final = (await store.get(sid))!;
  const users = final.messages.filter(m => m.role === 'user').map(textOf);
  assert.deepEqual(users, ['first', 'second'], 'both turns ran to completion, in order');
});

// ── The steer's target is fixed at arrival, not at the moment the decision lands ─────────────
//
// `s.running` is true across the pump's WHOLE queue, so it answers "something is running", never "still
// the one you meant". Any await in front of the decision can therefore outlive the turn the user was
// steering — the classifier and the nudge could already, and media ingestion (a full `store.list` walk
// plus a multi-megabyte `put`) can hold it for seconds. Aborting on `s.running` alone then kills a turn
// the user never saw, and reports the wrong `interruptedTraceId` on the way.

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}

/** `slow` again, but a fresh gate per invocation so two turns can each be held independently. */
function gatedTool(gates: ReadonlyArray<{ promise: Promise<void> }>, started: (n: number) => void): Tool {
  let n = 0;
  return {
    name: 'slow',
    description: 'blocks until its gate opens or the turn is aborted',
    inputSchema: { type: 'object' },
    executor: {
      execute(_input, ctx) {
        const gate = gates[n++]!;
        return (async function* () {
          started(n - 1);
          await new Promise<void>(resolve => {
            if (ctx.signal.aborted) return resolve();
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
            void gate.promise.then(() => resolve());
          });
          if (ctx.signal.aborted) throw new Error(String(ctx.signal.reason));
          yield { type: 'result', value: { done: true } };
        })();
      },
    },
  };
}

/** Tool-call on the given call indices, plain text otherwise — so chosen turns block and others don't. */
function providerCallingToolOn(indices: ReadonlySet<number>): ProviderAdapter {
  let calls = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const n = calls++;
      return (async function* () {
        if (indices.has(n)) yield { type: 'tool-call', id: `c${n}`, name: 'slow', input: {} };
        else                yield { type: 'text-delta', delta: 'done' };
        yield { type: 'done' };
      })();
    },
  };
}

/** A MediaStore whose listing blocks, standing in for a slow disk under a large attachment. */
function gatedMediaStore(gate: Promise<void>): MediaStore {
  const held = new Map<string, { meta: Omit<FileHandle, 'stream'>; bytes: Uint8Array }>();
  const handle = (h: { meta: Omit<FileHandle, 'stream'>; bytes: Uint8Array }): FileHandle =>
    ({ ...h.meta, stream: async function *() { yield h.bytes; } });
  return {
    async put(name, mimeType, data, meta) {
      const chunks: Uint8Array[] = [];
      for await (const c of data) chunks.push(c);
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
      const id = name ?? crypto.randomUUID();
      const h = { bytes, meta: { id, name: id, version: '1', mimeType, size: bytes.byteLength,
                                createdAt: new Date().toISOString(), ...meta } };
      held.set(id, h);
      return handle(h);
    },
    async get(id) { const h = held.get(id); return h ? handle(h) : null; },
    async getByName(n) { const h = held.get(n); return h ? handle(h) : null; },
    async delete(id) { held.delete(id); },
    async *list() { await gate; for (const h of held.values()) yield handle(h); },
    async putTemp() { throw new Error('putTemp unused'); },
  };
}

test('a steer targets the turn that was running when it ARRIVED, not whatever is running when it lands',
  { timeout: 20000 }, async () => {
  const session = createSession();
  const sid = session.id;
  const store = memStore(session);

  const gateA = deferred(), gateB = deferred(), gateMedia = deferred();
  const startedA = deferred(), startedB = deferred();
  const tools = toolRegistry(gatedTool([gateA, gateB], n => (n === 0 ? startedA : startedB).release()));
  // Calls 0 and 2 make a tool-call, so turn A and turn B each block in `slow`; 1 and 3 close them out.
  const runner = makeRunner(store, tools, providerCallingToolOn(new Set([0, 2])),
                            gatedMediaStore(gateMedia.promise));

  const view = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: text('first'), provider: 'fake', principal });
  const events: PipelineEvent[] = [];
  const collector = (async () => { for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; } })();

  await startedA.promise;                              // turn A is inside `slow`
  await runner.open({ sessionId: sid, signal: new AbortController().signal, content: text('second'), provider: 'fake', principal });

  // The steer arrives NOW, while A runs — so A is the turn it is for. Its media ingestion then blocks,
  // and is deliberately not awaited: that hold is the whole point of the test.
  const steering = runner.open({
    sessionId: sid, signal: new AbortController().signal, provider: 'fake', principal, mode: 'interrupt',
    content: [{ type: 'text', text: 'STEER' },
              { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' as MimeType, name: 'cat.png' }],
  });

  gateA.release();                                     // A finishes and commits; the pump moves to B
  await startedB.promise;                              // and B is now the running turn
  gateMedia.release();                                 // only now does the steer reach its decision
  await steering;

  assert.ok(!events.some(e => e.type === 'aborted'),
    'B was not aborted: the turn the steer was for had already committed, so there was nothing to interrupt');
  assert.ok(!events.some(e => e.type === 'steer'),
    'and it was not announced as a steer either — it is an ordinary queued follow-up now');

  gateB.release();
  await collector;

  const final = (await store.get(sid))!;
  assert.deepEqual(final.messages.filter(m => m.role === 'user').map(textOf), ['first', 'second', 'STEER'],
    'all three ran in arrival order, the steer last');
  assert.equal(final.messages.flatMap(m => m.content).filter(c => c.type === 'image').length, 0,
    'and its attachment persisted as a ref, not bytes');
});
