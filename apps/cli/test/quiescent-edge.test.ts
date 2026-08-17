import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, HookRegistry,
  onContextQuiesce, flushIfQuiescent, machineBusy,
} from '@matatbread/matbot-core';
import type {
  Session, Store, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  Principal, MessageContent,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// The quiescent edge is where deferred machine state lands — a StorageBackend swap, a plugin's
// deferred edit of the session a turn is running in. It used to be raised per TURN, which read as
// idle across the pump's own post-commit work: reading the committed document back for followup,
// appending markers to it, rewriting it for a retract, and persisting the next queued turn's user
// message. A mutation landing there splits exactly what the deferral exists to keep whole, and the
// gap is invisible from outside — no test would have failed, the swap would just have happened at
// the wrong moment. So the invariant is asserted directly: no edge exposes the middle of a queue.

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

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

test('no quiescent edge falls between two turns of one queue', { timeout: 15000 }, async () => {
  let turnsAnswered = 0;
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      return (async function* () {
        yield { type: 'text-delta', delta: 'answer' };
        yield { type: 'done' };
        turnsAnswered++;
      })();
    },
  };

  // A retract gives the pump the whole post-commit region to work through — a store re-read, a
  // rewrite of the committed document, and a second turn head-enqueued behind it.
  let retracted = false;
  const hooks = new HookRegistry();
  hooks.register({
    on: 'followup',
    pluginName: 'retractor',
    handler: () => {
      if (retracted) return undefined;
      retracted = true;
      return { retractAndRerun: { context: text('again') } };
    },
  });

  // What each edge saw. The pump raises its hold before the first turn and drops it when the queue
  // drains, so the only legal observations are "nothing has run yet" and "everything has".
  const seen: number[] = [];
  const un = onContextQuiesce(() => { seen.push(turnsAnswered); });

  try {
    const session = createSession();
    const runner  = createSessionRunner({
      store:           memStore(session),
      resolveProvider: async () => ({ adapter, config: { name: 'fake', module: 'fake', model: 'fake' } as ProviderConfig }),
      tools:           emptyTools,
      loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
      unloadPlugin:    async () => false,
      hooks,
    });

    const view = await runner.open({
      sessionId: session.id, signal: new AbortController().signal,
      content: text('go'), provider: 'fake', principal,
    });
    for await (const ev of view.events) if (ev.type === 'idle') break;

    assert.ok(retracted, 'the hook fired, so the pump really did run two turns');
    assert.equal(turnsAnswered, 2);
    assert.ok(seen.length > 0, 'the edge was reached at all');
    assert.ok(!seen.includes(1), `an edge fell between the two turns: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes(2), 'the drained queue is an edge');
  } finally {
    un();
  }
});

test('a hold is released on every exit, so nothing can strand the machine', async () => {
  let fired = 0;
  const un = onContextQuiesce(() => { fired++; });

  try {
    // A stuck counter is unrecoverable — every later flush no-ops forever, and the only symptom is a
    // deferred mutation that never happens — so each way out of a hold is checked, not just the
    // happy one.
    assert.throws(() => machineBusy(() => { throw new Error('sync boom'); }), /sync boom/);
    assert.ok(fired > 0, 'a synchronous throw still released the hold');

    fired = 0;
    await assert.rejects(machineBusy(async () => { throw new Error('async boom'); }), /async boom/);
    assert.ok(fired > 0, 'a rejected promise still released the hold');

    fired = 0;
    machineBusy(() => 'sync value');
    assert.ok(fired > 0, 'a synchronous return released the hold');

    // Nesting: only the outermost release is an edge. Reset inside, the entry edge having already run.
    fired = 0;
    await machineBusy(async () => {
      fired = 0;
      await machineBusy(async () => { /* inner operation */ });
      assert.equal(fired, 0, 'the inner release is not an edge while the outer hold stands');
    });
    assert.ok(fired > 0, 'the outermost release is the edge');

    // And the machine is genuinely idle afterwards, not merely un-flushed.
    fired = 0;
    flushIfQuiescent();
    assert.equal(fired, 1, 'the machine is idle after all of that');
  } finally {
    un();
  }
});
