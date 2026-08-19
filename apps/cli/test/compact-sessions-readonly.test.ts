import { test } from 'node:test';
import assert from 'node:assert/strict';
// Values through core, which re-exports them: apps/cli deliberately has no direct plugin-api dependency.
import { readOnlyError, runAs, installPrincipalCarrier } from '@matatbread/matbot-core';
import type { Session, Store, ToolContext } from '@matatbread/matbot-plugin-api';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';
import { makeCompactSessionsTool } from '../../../plugins/edit-session/src/compact-sessions.ts';

// `compact_sessions` sweeps the WHOLE session store, and a store partitioned by profile holds sessions
// this principal may read and may not write — a share, whose `cas` throws a branded ReadOnlyError. That
// error is documented as "a per-operation condition, not a process fault", and the tool's own contract
// has a `skipped: Array<{ sessionId, title, reason }>` for sessions it could not process. It caught
// nothing: the first shared-in session aborted the sweep, so a profile with any share in it compacted
// NOTHING and got an exception instead of a report — while `skipped` sat there advertising the opposite.
//
// Caught, not pre-checked. Ownership lives behind an optional backend capability (`ProfileDirectory`),
// so a pre-check would couple this plugin to one backend, still race a share landing between the check
// and the write, and miss every other medium that enforces the same rule a different way. The write is
// the only authority on whether the write is allowed.

installPrincipalCarrier(createAlsPrincipalCarrier());

const READ_ONLY = new Set(['shared-in-first', 'shared-in-second']);

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id, version: 'v1', title: `title of ${id}`, status: 'active',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),           // epoch: always past any inactiveDays threshold
    messages: [
      { id: `${id}-m1`, role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', id: 't1', name: 'x', input: {} }] },
      { id: `${id}-m2`, role: 'user',      content: [{ type: 'text', text: 'bye' }] },
    ],
    ...over,
  } as Session;
}

// Ordered so a shared-in session is examined FIRST — the reported failure is that nothing at all got
// compacted, which only shows up if the abort happens before any owned session is reached.
const seed = [
  session('shared-in-first'),
  session('owned-archived', { status: 'archived' }),
  session('shared-in-second'),
  session('owned-fresh', { updatedAt: new Date().toISOString() }),   // recent + short: below thresholds
];

function partitionedStore(): { store: Store<Session>; writes: string[] } {
  const map    = new Map(seed.map(s => [s.id, structuredClone(s)]));
  const writes: string[] = [];
  const store: Store<Session> = {
    async get(id)  { return map.get(id) ?? null; },
    async set()    { throw new Error('compact_sessions must write through cas, never set'); },
    async cas(id, _expected, next) {
      // Exactly what the profiles backend does on a write to a shared-in item: refuse, naming the owner.
      if (READ_ONLY.has(id)) throw readOnlyError('sessions', id, '');   // '' = the base/global partition
      writes.push(id);
      map.set(id, next);
      return { ok: true as const, doc: next };
    },
    async delete() { return false; },
    async query()  { return { items: [...map.values()] }; },
  };
  return { store, writes };
}

type Report = {
  examined: number;
  compacted: Array<{ sessionId: string; tier: string; messagesStripped: number }>;
  skipped:   Array<{ sessionId: string; title: string; reason: string }>;
  deferred:  Array<{ sessionId: string }>;
};

async function sweep(store: Store<Session>): Promise<Report> {
  const tool = makeCompactSessionsTool(store);
  // A session id no page holds: the calling session is DEFERRED to the quiescent edge, which is a
  // separate path with its own host machinery. This test is about the inline sweep.
  const ctx = { session: { id: 'not-in-the-store' } } as unknown as ToolContext;
  return runAs({ id: 'matt', type: 'user' }, async () => {
    for await (const ev of tool.executor.execute({}, ctx)) {
      if (ev.type === 'result') return ev.value as unknown as Report;
      if (ev.type === 'error')  throw new Error(ev.message);
    }
    throw new Error('compact_sessions yielded no result');
  });
}

test('a read-only session shared in from another profile is skipped, not fatal', async () => {
  const { store, writes } = partitionedStore();
  const report = await sweep(store);

  assert.equal(report.examined, seed.length, 'every session in the store is examined');

  // The point of the whole fix: the owned session past the first share still gets compacted.
  assert.deepEqual(writes, ['owned-archived'], 'the owned session is compacted; neither share is written');
  assert.equal(report.compacted.length, 1);
  assert.equal(report.compacted[0]?.sessionId, 'owned-archived');
  assert.ok((report.compacted[0]?.messagesStripped ?? 0) > 0, 'and it really was stripped');

  const skipped = new Map(report.skipped.map(s => [s.sessionId, s]));
  for (const id of READ_ONLY) {
    const entry = skipped.get(id);
    assert.ok(entry, `${id} must be reported under skipped`);
    assert.match(entry.reason, /read-only/i, `the reason must say why: got ${JSON.stringify(entry.reason)}`);
    // The owner is the actionable half — which profile to go and ask. `''` is the base partition, and
    // the reason renders it the way ReadOnlyError's own message does rather than leaking the sentinel.
    assert.match(entry.reason, /global/, `the reason must name the owner: got ${JSON.stringify(entry.reason)}`);
    assert.equal(entry.title, `title of ${id}`, 'a skipped session is still identifiable');
  }

  assert.equal(skipped.get('owned-fresh')?.reason, 'below thresholds', 'ordinary skips are unchanged');
});

test('a fault that is not a per-operation refusal still aborts the sweep', async () => {
  const { store } = partitionedStore();
  const broken: Store<Session> = { ...store, async cas(id, e, next) {
    if (id === 'owned-archived') throw new Error('backend is on fire');
    return store.cas(id, e, next);
  } };

  // The counterpart to the fix, and the reason it catches one branded error rather than everything: a
  // real fault reported as a cosmetic `skipped` line would have the tool announce a successful sweep it
  // never performed.
  await assert.rejects(() => sweep(broken), /backend is on fire/);
});
