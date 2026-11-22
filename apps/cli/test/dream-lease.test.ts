import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { acquireLease, type DreamLease } from '../../../plugins/cognition/src/dream/lease.ts';

// One dream-time pass at a time, across processes: a scheduled pass runs in a job's own process beside any
// started in the server, and two passes over one fact store merged and retired the same fact a second
// apart. The lease is a stored document with an expiry, taken by write, settle, read back.

const opts = { settleMs: 5 };

test('a second pass is refused while the lease is held, and admitted once it is released', async () => {
  const store = new MemoryStore<DreamLease>();
  const a = await acquireLease(store, 'a', opts);
  assert.ok(a.held);
  const b = await acquireLease(store, 'b', opts);
  assert.ok(!b.held);
  assert.equal(b.by.holder, 'a');
  await a.release();
  const c = await acquireLease(store, 'c', opts);
  assert.ok(c.held);
  await c.release();
});

test('a lease left by a crashed process lapses at its expiry', async () => {
  const store = new MemoryStore<DreamLease>();
  const past = new Date(Date.now() - 1000).toISOString();
  await store.set('pass', { id: 'pass', version: 'v', holder: 'crashed', acquiredAt: past, expiresAt: past });
  const b = await acquireLease(store, 'b', opts);
  assert.ok(b.held, 'an expired lease is taken over');
  await b.release();
});

test('of two passes contending at once, exactly one proceeds', async () => {
  const store = new MemoryStore<DreamLease>();
  const [a, b] = await Promise.all([acquireLease(store, 'a', opts), acquireLease(store, 'b', opts)]);
  assert.equal([a, b].filter(l => l.held).length, 1);
  for (const l of [a, b]) if (l.held) await l.release();
});

test('a holder overtaken after stalling past its expiry is told it lost the lease', async () => {
  const store = new MemoryStore<DreamLease>();
  const a = await acquireLease(store, 'a', { ...opts, ttlMs: 20, renewEveryMs: 40 });
  assert.ok(a.held);
  await new Promise(r => setTimeout(r, 25));
  const b = await acquireLease(store, 'b', opts);
  assert.ok(b.held, 'the lapsed lease is taken');
  await new Promise(r => setTimeout(r, 40));
  assert.ok(a.lost.aborted, 'the stalled holder learns at its next renewal');
  await a.release();
  assert.equal((await store.get('pass'))?.holder, 'b', 'and releasing it leaves the new holder alone');
  await b.release();
});
