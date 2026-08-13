import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, HookRegistry,
  usageEntries,
} from '@matatbread/matbot-core';
import type {
  Session, Store, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  Principal, MessageContent,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// A retract-and-rerun re-runs an ALREADY-COMMITTED user turn under a fresh traceId, and deliberately
// introduces no user message of its own — the pop keeps the original. So the redo's entries have no turn
// head of their own to anchor on, and were dropped outright by the flush: a retried turn silently
// reported only the attempt that was thrown away, which is the exact under-report anchoring on the turn
// head exists to prevent.
//
// This is here because the condition is hard to provoke by hand: it needs a trigger to judge a response
// wrong, which is a live-classifier decision. A hook makes it deterministic.

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

const emptyTools = {
  register: () => { throw new Error('register unused'); },
  unregister: () => { throw new Error('unregister unused'); },
  resolve: () => null,
  list: () => [],
  has: () => false,
} as unknown as ToolRegistry;

// One round per turn, with usage, so each attempt books exactly one entry.
function answersPlainly(): ProviderAdapter {
  let n = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const attempt = ++n;
      return (async function* () {
        yield { type: 'text-delta', delta: `attempt ${attempt}` };
        yield { type: 'usage', inputTokens: 100 * attempt, outputTokens: attempt };
        yield { type: 'done' };
      })();
    },
  };
}

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

test('a retried turn accounts for both attempts', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);

  // Retract exactly once — the redo's own followup must not retract again, or the turn never settles.
  let retracted = false;
  const hooks = new HookRegistry();
  hooks.register({
    on: 'followup',
    pluginName: 'retractor',
    handler: () => {
      if (retracted) return undefined;
      retracted = true;
      return { retractAndRerun: { context: text('that was wrong, try again') } };
    },
  });

  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  // ONE adapter across both attempts — resolveProvider runs per turn, so building it inline would
  // reset the attempt counter and make the two attempts indistinguishable.
  const adapter = answersPlainly();
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config }),
    tools: emptyTools,
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
    hooks,
  });

  const view = await runner.open({
    sessionId: session.id, signal: new AbortController().signal,
    content: text('go'), provider: 'fake', principal,
  });
  // The redo is head-enqueued, so the first `idle` is the real end of both attempts.
  for await (const ev of view.events) if (ev.type === 'idle') break;

  const saved = await store.get(session.id);
  assert.ok(retracted, 'the hook fired');

  const rounds = usageEntries(saved!.messages).filter(e => e.site?.kind === 'round');
  assert.equal(rounds.length, 2, 'the discarded attempt is still spend that was billed');
  assert.deepEqual(rounds.map(r => r.usage.inputTokens).sort((a, b) => a - b), [100, 200]);

  // Both anchored on the ONE user message the pop kept — the redo introduced none of its own, so
  // without the root fallback its entry had nowhere to go and was dropped.
  const heads = saved!.messages.filter(m => m.role === 'user' && (m.activity?.length ?? 0) > 0);
  assert.equal(heads.length, 1);
  assert.equal(heads[0]!.activity!.length, 2);

  // The retry ran under its own traceId, and says so — attribution stays precise even though the
  // anchor is shared.
  const traces = new Set(rounds.map(r => r.traceId));
  assert.equal(traces.size, 2, 'two distinct turns');
  assert.ok(rounds.every(r => r.rootTraceId === heads[0]!.traceId), 'both rooted at the turn retried');
});
