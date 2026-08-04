import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, HookRegistry } from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  PipelineEvent, Principal, MessageContent,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// `ProviderConfig.maxRounds` — the per-profile ceiling on agentic rounds in one turn. The provider
// below never stops asking for tools, which is the case the ceiling exists for: without it the loop
// has no upper bound at all, and each round is a full provider call carrying the whole history.
//
// Paired with it: `followup` must NOT run for a turn the ceiling stopped. A followup hook may
// `resubmit`, which starts a fresh turn with a fresh budget — so a ceiling that still allowed followup
// would be worth 8x its stated value (MAX_RESUBMIT_DEPTH) rather than what was configured.

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

function toolRegistry(tool: Tool): ToolRegistry {
  return {
    register: () => { throw new Error('register unused'); },
    unregister: () => { throw new Error('unregister unused'); },
    resolve: name => (name === tool.name ? tool : null),
    list: () => [tool],
    has: name => name === tool.name,
  } as unknown as ToolRegistry;
}

const loopTool: Tool = {
  name: 'loop',
  description: 'always succeeds',
  inputSchema: { type: 'object', properties: {} },
  executor: { async *execute() { yield { type: 'result', value: 'again' }; } },
};

// Never stops calling tools, however it is answered.
function relentless(counter: { calls: number }): ProviderAdapter {
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const n = counter.calls++;
      return (async function* () {
        yield { type: 'text-delta', delta: `round ${n + 1}` };
        yield { type: 'tool-call', id: `c${n}`, name: 'loop', input: {} };
        yield { type: 'done' };
      })();
    },
  };
}

function makeRunner(store: Store<Session>, adapter: ProviderAdapter, maxRounds?: number, hooks?: HookRegistry) {
  const config: ProviderConfig = {
    name: 'fake', module: 'fake', model: 'fake',
    ...(maxRounds !== undefined ? { maxRounds } : {}),
  };
  return createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config }),
    tools: toolRegistry(loopTool),
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
    ...(hooks !== undefined ? { hooks } : {}),
  });
}

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

async function run(runner: ReturnType<typeof makeRunner>, sid: string): Promise<PipelineEvent[]> {
  const view = await runner.open({
    sessionId: sid, signal: new AbortController().signal,
    content: text('go'), provider: 'fake', principal,
  });
  const events: PipelineEvent[] = [];
  for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; }
  return events;
}

test('maxRounds bounds a turn that would otherwise loop forever', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const counter = { calls: 0 };
  const events  = await run(makeRunner(store, relentless(counter), 3), session.id);

  assert.equal(counter.calls, 3, 'exactly maxRounds provider calls');

  const terminal = events.filter(e => e.type === 'done' || e.type === 'aborted' || e.type === 'error');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]!.type, 'aborted');
  assert.match((terminal[0] as { reason: string }).reason, /^round-limit: /);

  // Everything the turn did is committed — the ceiling is not a reason to lose work.
  const saved = await store.get(session.id);
  assert.equal(saved!.messages.filter(m => m.role === 'assistant').length, 3);

  // and every tool_use is paired, so the next submission is still valid
  const calls   = new Set(saved!.messages.flatMap(m => m.content.filter(c => c.type === 'tool-call').map(c => c.id)));
  const results = new Set(saved!.messages.flatMap(m => m.content.filter(c => c.type === 'tool-result').map(c => c.id)));
  assert.deepEqual([...calls].filter(id => !results.has(id)), [], 'no unpaired tool_use');
});

test('maxRounds absent leaves the loop unbounded (historical behaviour)', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const counter = { calls: 0 };

  // No ceiling, so bound it externally: a hook aborts at round 4 to keep the test finite. The point is
  // that the RUNNER did not stop it — with maxRounds unset it ran past any ceiling a config could imply.
  const hooks = new HookRegistry();
  hooks.register({
    on: 'toolcall',
    handler: ctx => (ctx.session.messages.filter(
      m => m.role === 'assistant' && m.traceId === ctx.config.traceId).length > 4
        ? { abort: 'test guard' } : undefined),
  });

  const events = await run(makeRunner(store, relentless(counter), undefined, hooks), session.id);
  assert.equal(counter.calls, 5, 'ran past any implied ceiling');
  const terminal = events.find(e => e.type === 'aborted') as { reason: string } | undefined;
  assert.equal(terminal?.reason, 'test guard');
});

test('followup does not run for a turn the ceiling stopped', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);

  let followupRan = 0;
  const hooks = new HookRegistry();
  hooks.register({ on: 'followup', handler: () => { followupRan += 1; return undefined; } });

  await run(makeRunner(store, relentless({ calls: 0 }), 2, hooks), session.id);
  assert.equal(followupRan, 0, 'a resubmit here would grant a fresh round budget');
});

test('followup still runs for a turn that completes', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);

  // Answers once with plain text — no tool call, so the turn ends `done` on round 1.
  const polite: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      return (async function* () {
        yield { type: 'text-delta', delta: 'all done' };
        yield { type: 'done' };
      })();
    },
  };

  let followupRan = 0;
  const hooks = new HookRegistry();
  hooks.register({ on: 'followup', handler: () => { followupRan += 1; return undefined; } });

  const events = await run(makeRunner(store, polite, 10, hooks), session.id);
  assert.ok(events.some(e => e.type === 'done'));
  assert.equal(followupRan, 1, 'the gate must not suppress the normal path');
});
