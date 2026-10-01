import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, HookRegistry } from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  Message, PipelineEvent, Principal, MessageContent,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// `mode: 'parallel'`: a submission arriving mid-turn is answered at once on a copy of the session's
// completed turns, leaving the running turn alone, and only the submission and its final reply come back
// — as a user/assistant pair placed ahead of the running turn's own messages (where the copy ended) if it
// is still running, else appended after it.

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

function gate(): { open: () => void; wait: Promise<void> } {
  let open = (): void => {};
  const wait = new Promise<void>(r => { open = r; });
  return { open, wait };
}

function slowTool(started: () => void, release: Promise<void>): Tool {
  return {
    name: 'slow',
    description: 'blocks until released',
    inputSchema: { type: 'object' },
    executor: {
      execute() {
        return (async function* () {
          started();
          await release;
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

const textOf = (m: Pick<Message, 'content'>): string =>
  m.content.filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text').map(c => c.text).join(' ');

// One adapter serves both runners. The parallel turn is recognised by its framing (the running request,
// folded onto its message in the copy); the main turn calls `slow` once, then answers.
function fakeProvider(seen: { main: Message[][]; parallel: Message[][] }, parallelGate: Promise<void>): ProviderAdapter {
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      const isParallel = messages.some(m => textOf(m).includes('<running-request>'));
      (isParallel ? seen.parallel : seen.main).push(messages);
      const afterTool = messages[messages.length - 1]?.role === 'tool';
      return (async function* () {
        if (isParallel) {
          await parallelGate;
          yield { type: 'text-delta', delta: 'A' };
        } else if (afterTool) {
          yield { type: 'text-delta', delta: 'main done' };
        } else {
          yield { type: 'tool-call', id: 'c1', name: 'slow', input: {} };
        }
        yield { type: 'done' };
      })();
    },
  };
}

function setup(parallelGate: Promise<void>, hooks?: HookRegistry) {
  const session = createSession();
  const store   = memStore(session);
  const seen    = { main: [] as Message[][], parallel: [] as Message[][] };
  const started = gate();
  const release = gate();
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const runner  = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: fakeProvider(seen, parallelGate), config }),
    tools: toolRegistry(slowTool(started.open, release.wait)),
    ...(hooks !== undefined ? { hooks } : {}),
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
  });
  return { sid: session.id, store, seen, started, release, runner };
}

async function watch(view: { events: AsyncIterable<PipelineEvent> }, events: PipelineEvent[], on?: (ev: PipelineEvent) => void): Promise<void> {
  for await (const ev of view.events) { events.push(ev); on?.(ev); if (ev.type === 'idle') break; }
}

const submit = (text: string) => [{ type: 'text' as const, text }];

test('parallel reply lands ahead of the still-running turn, at a round boundary', { timeout: 10000 }, async () => {
  const { sid, store, seen, started, release, runner } = setup(Promise.resolve());

  const main = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: submit('do it'), provider: 'fake', principal });
  const events: PipelineEvent[] = [];
  const collector = watch(main, events);

  await started.wait;   // the main turn is inside `slow`
  const par = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: submit('Q'), provider: 'fake', principal, mode: 'parallel' });
  assert.equal(runner.status(sid).parallel, 1, 'counted while in flight');

  // Settled means its reply is waiting to be placed — after its own `done`, once its runner has idled.
  while (runner.status(sid).parallel > 0) await new Promise(r => setImmediate(r));
  release.open();       // only now can the main turn reach its next round boundary
  await collector;

  const announced = events.find(e => e.type === 'parallel');
  assert.ok(announced && announced.type === 'parallel' && announced.runningTraceId === main.traceId && announced.traceId === par.traceId,
    'announced against the running turn');
  const merged = events.find(e => e.type === 'merged');
  assert.ok(merged && merged.type === 'merged' && merged.traceId === par.traceId && merged.into === main.traceId,
    'merged INTO the running turn');
  assert.ok(events.some(e => e.type === 'text-delta' && e.traceId === par.traceId), 'parallel progress streamed under its own traceId');
  assert.equal(events.filter(e => e.type === 'idle').length, 1, 'one idle, at the very end');

  // The copy ran on completed turns only — here, none — with the running request as framing, not history.
  const parCall = seen.parallel[0]!;
  assert.ok(!parCall.some(m => m.role === 'user' && textOf(m) === 'do it'), 'running turn not in the copy');

  const final = (await store.get(sid))!;
  assert.deepEqual(final.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(textOf(final.messages[0]!), 'Q', 'submission persisted without its framing');
  assert.equal(textOf(final.messages[1]!), 'A', 'only the final reply came back');
  assert.equal(textOf(final.messages[2]!), 'do it');
  assert.equal(textOf(final.messages[5]!), 'main done');

  // The main turn's next round read the pair, ahead of its own request.
  const next = seen.main[1]!.map(m => textOf(m));
  assert.deepEqual(next.slice(0, 3), ['Q', 'A', 'do it']);
});

test('parallel reply that outlives the running turn is appended after it', { timeout: 10000 }, async () => {
  const parallelGate = gate();
  const { sid, store, started, release, runner } = setup(parallelGate.wait);

  const main = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: submit('do it'), provider: 'fake', principal });
  const events: PipelineEvent[] = [];
  const mainDone = gate();
  const collector = watch(main, events, ev => { if (ev.type === 'done' && ev.traceId === main.traceId) mainDone.open(); });

  await started.wait;
  const par = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: submit('Q'), provider: 'fake', principal, mode: 'parallel' });
  release.open();
  await mainDone.wait;
  parallelGate.open();
  await collector;

  const merged = events.find(e => e.type === 'merged');
  assert.ok(merged && merged.type === 'merged' && merged.traceId === par.traceId && merged.into === undefined, 'appended, not interjected');
  const idleAt = events.findIndex(e => e.type === 'idle');
  assert.ok(idleAt > events.indexOf(merged), 'no idle while the parallel turn was still out');

  const final = (await store.get(sid))!;
  assert.deepEqual(final.messages.map(m => textOf(m) || m.role), ['do it', 'assistant', 'tool', 'main done', 'Q', 'A']);
  assert.equal(runner.status(sid).busy, false);
});

test('parallel with nothing running degrades to an ordinary turn', { timeout: 10000 }, async () => {
  const { sid, store, release, runner } = setup(Promise.resolve());
  release.open();
  const view = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: submit('do it'), provider: 'fake', principal, mode: 'parallel' });
  const events: PipelineEvent[] = [];
  await watch(view, events);
  assert.ok(!events.some(e => e.type === 'parallel'));
  assert.deepEqual((await store.get(sid))!.messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
});

// A parallel reply that settles after the running turn's last round, while a followup hook judges it, used
// to be appended between turns — after the retraction marker, ahead of the redo. The redo then took the
// parallel message for the turn to re-run, on a history ending in an assistant message (a prefill), and
// the retracted turn was never answered.
test('a retract-and-rerun re-runs the retracted turn, not a parallel reply that settled meanwhile', { timeout: 10000 }, async () => {
  const parallelGate = gate();
  const hooks = new HookRegistry();
  let retracted = false;
  let runner!: ReturnType<typeof setup>['runner'];
  let sid!: string;
  hooks.register({ on: 'followup', pluginName: 'retractor', handler: async () => {
    if (retracted) return {};
    retracted = true;
    parallelGate.open();
    while (runner.status(sid).parallel > 0) await new Promise(r => setImmediate(r));
    return { retractAndRerun: {} };
  } });
  const t = setup(parallelGate.wait, hooks);
  ({ runner, sid } = t);
  const { store, seen, started, release } = t;

  const main = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: submit('do it'), provider: 'fake', principal });
  const events: PipelineEvent[] = [];
  const collector = watch(main, events);
  await started.wait;
  await runner.open({ sessionId: sid, signal: new AbortController().signal, content: submit('Q'), provider: 'fake', principal, mode: 'parallel' });
  release.open();
  await collector;

  // The redo's first call reads the retracted request as its last message — not the parallel pair. (Markers
  // reach the adapter, which elides them.)
  const last = seen.main[2]!.findLast(m => m.role !== 'marker')!;
  assert.equal(last.role, 'user');
  assert.equal(textOf(last), 'do it');

  // The pair was placed where the copy it ran on ended: ahead of the turn it ran beside.
  const final = (await store.get(sid))!;
  assert.deepEqual(final.messages.map(m => m.role === 'marker' ? 'marker' : textOf(m) || m.role),
    ['Q', 'A', 'do it', 'marker', 'assistant', 'tool', 'main done']);
});
