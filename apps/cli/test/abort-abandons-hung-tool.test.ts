import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier } from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  Message, PipelineEvent, Principal, MessageContent,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// An abort must abort. The runner used to iterate a tool executor with a bare `for await`, so a tool
// that never returns held the turn open for ever with nothing left in the process able to end it — the
// session sat at "working" and every further abort reported success, because the abort itself worked and
// the tool call was simply unreachable. `bash` reached that state through inherited file descriptors
// (MatAtBread/matbot#47, #48), but any executor can: a generator awaiting something that never settles,
// a bridged remote that went away. So the bound belongs here rather than in each tool.
//
// It is a bound, not a cancellation: only armed once the signal is aborted, so a legitimately long tool
// on a healthy turn is never cut short, and a well-behaved tool cleaning up after a cut-off is waited
// for. What must survive is the transcript — every tool_use needs its tool_result, or the next request
// is rejected by the provider.

const ABANDONED_TOOL_GRACE_MS = 30_000;   // mirrors core/src/runner.ts

const principal: Principal = { id: 'tester', type: 'user' };

function memStore(seed: Session): Store<Session> {
  const m = new Map<string, Session>([[seed.id, seed]]);
  return {
    get:    async id => m.get(id) ?? null,
    set:    async (id, v) => { m.set(id, v); },
    cas:    async () => { throw new Error('cas unused'); },
    delete: async () => { throw new Error('delete unused'); },
    query:  async () => { throw new Error('query unused'); },
  };
}

// Deaf to the abort, and never returns from `return()` either — the shape a tool leaking a child process
// actually has. `started` fires once the runner is inside it.
function deafTool(started: () => void): Tool {
  return {
    name:        'deaf',
    description: 'ignores the abort signal entirely',
    inputSchema: { type: 'object' },
    executor: {
      execute() {
        return {
          [Symbol.asyncIterator]: () => ({
            next:   () => { started(); return new Promise<IteratorResult<never>>(() => { /* never */ }); },
            return: () => new Promise<IteratorResult<never>>(() => { /* nor this */ }),
          }),
        };
      },
    },
  };
}

function toolRegistry(tool: Tool): ToolRegistry {
  const map = new Map<string, Tool>([[tool.name, tool]]);
  return {
    register:       t => { map.set(t.name, t); },
    remove:         n => { map.delete(n); },
    resolve:        n => map.get(n) ?? null,
    list:           () => [...map.values()],
    removeByPlugin: () => {},
    watch:          async function* () {},
  };
}

function fakeProvider(): ProviderAdapter {
  let calls = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const n = calls++;
      return (async function* () {
        if (n === 0) yield { type: 'tool-call', id: 'c1', name: 'deaf', input: {} };
        else         yield { type: 'text-delta', delta: 'continued' };
        yield { type: 'done' };
      })();
    },
  };
}

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];
const roles = (s: Session): string[] => s.messages.map(m => m.role);

test('an aborted turn ends even when the tool never returns', { timeout: 20000 }, async () => {
  const session = createSession();
  const sid     = session.id;
  const store   = memStore(session);
  let fire: () => void = () => {};
  const startedP = new Promise<void>(r => { fire = r; });
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: fakeProvider(), config }),
    tools:           toolRegistry(deafTool(() => fire())),
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });

  const view = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: text('do it'), provider: 'fake', principal });
  const events: PipelineEvent[] = [];
  const collector = (async () => { for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; } })();

  await startedP;   // inside the tool, which will never yield again

  // The grace is a constant, not a knob — so the clock is the thing the test controls. Enabled only
  // around the abort, so the runner's own timers before and after stay real.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    runner.abort(sid);
    await new Promise<void>(r => setImmediate(r));   // let the abort reach the deadline's listener
    mock.timers.tick(ABANDONED_TOOL_GRACE_MS + 1);
  } finally {
    mock.timers.reset();
  }
  await collector;

  const aborted = events.find(e => e.type === 'aborted');
  assert.ok(aborted, `the turn ended, got ${JSON.stringify(events.map(e => e.type))}`);

  // And it ended WELL-FORMED: the tool message is there, so the next request has a tool_result for
  // every tool_use rather than a dangling call the provider rejects.
  const final = (await store.get(sid))!;
  assert.deepEqual(roles(final), ['user', 'assistant', 'tool'], 'the abandoned call still got its result');
  const toolMsg  = final.messages[2]!;
  const toolPart = toolMsg.content.find((c): c is Extract<MessageContent, { type: 'tool-result' }> => c.type === 'tool-result');
  assert.ok(toolPart?.isError, 'recorded as an error…');
  assert.match(String((toolPart.result as { error: string }).error), /interrupted/i, '…reframed as an interruption, not a fault');
});

test('a tool that returns promptly on abort is not made to wait for the grace', { timeout: 20000 }, async () => {
  // The bound must not become the abort path: the common case is a tool that notices and cleans up, and
  // it should end the turn immediately — with real timers, so a 30s grace would fail this outright.
  const session = createSession();
  const sid     = session.id;
  const store   = memStore(session);
  let fire: () => void = () => {};
  const startedP = new Promise<void>(r => { fire = r; });
  const politeTool: Tool = {
    name: 'deaf', description: 'ends on abort', inputSchema: { type: 'object' },
    executor: {
      execute(_input, ctx) {
        return (async function* () {
          fire();
          await new Promise<void>(r => ctx.signal.addEventListener('abort', () => r(), { once: true }));
          yield { type: 'error', message: String(ctx.signal.reason) };
        })();
      },
    },
  };
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: fakeProvider(), config }),
    tools:           toolRegistry(politeTool),
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });

  const view = await runner.open({ sessionId: sid, signal: new AbortController().signal, content: text('do it'), provider: 'fake', principal });
  const events: PipelineEvent[] = [];
  const collector = (async () => { for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; } })();

  await startedP;
  const t0 = Date.now();
  runner.abort(sid);
  await collector;
  assert.ok(Date.now() - t0 < 5000, `ended on the tool, not on the grace (took ${Date.now() - t0}ms)`);
  assert.ok(events.some(e => e.type === 'aborted'));
});
