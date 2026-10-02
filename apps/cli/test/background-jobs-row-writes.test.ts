import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASResult, MatbotMachine, QueryResult, Store, StoreQuery, Tool } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { createBackgroundJobsPlugin, BOOT_GRACE_MS } from '../../../plugins/background-jobs/src/index.ts';

// A job row has several writers and they race each other: the scheduler stamping `lastRun`/`nextRun` when
// a run ends, a `suspend` flipping `active`, a `cancel` deleting it. The stamp used to be a plain `set`
// built from a read taken before the run finished, so whatever landed in between was erased by it — a
// suspend undone, and a CANCELLED row written back, to be armed again on the next boot. The property under
// test is that no writer of a row overwrites a document it has not read.
//
// And that a one-shot is deleted because it RAN, not merely because it was reached: a run that could not
// start (no provider to run as, a failed spawn — the runner reports `undefined`) used to delete the row
// anyway, losing a scheduled request outright, unrun and unreported, for a usually-transient condition.

interface Row {
  id: string; version: string; prompt: string; createdAt: string; nextRun: string;
  intervalMs?: number; active?: boolean; lastRun?: string; lastReply?: string;
}

/**
 * The jobs store, with a one-shot hook that fires on the first write to reach it — standing in for another
 * writer landing in the gap between this writer's read and its write. The competing write goes straight to
 * `inner`, so it does not re-enter the hook.
 */
function racing(inner: Store<Row>, competing: (inner: Store<Row>) => Promise<void>): Store<Row> {
  let armed = true;
  const fire = async (): Promise<void> => { if (armed) { armed = false; await competing(inner); } };
  return {
    get:    (id: string) => inner.get(id),
    query:  (q: StoreQuery) => inner.query(q) as Promise<QueryResult<Row>>,
    delete: (id: string, v?: string) => inner.delete(id, v),
    async set(id: string, value: Row): Promise<void> { await fire(); return inner.set(id, value); },
    async cas(id: string, expected: string, next: Row): Promise<CASResult<Row>> { await fire(); return inner.cas(id, expected, next); },
  };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

// Boot the plugin over `store` with a runner whose every run resolves to `outcome`, and let the arming
// grace and the startup stagger elapse. Returns a teardown.
async function armed(
  store: Store<Row>,
  outcome: { appended: number; reply: string } | undefined,
  tick: (ms: number) => void,
  staggerMs: number,
): Promise<{ ran: string[]; stop: () => Promise<void> }> {
  const ran: string[] = [];
  const plugin = createBackgroundJobsPlugin({
    description: 'test',
    runner: () => ({ run: async job => { ran.push(job.id); return outcome; } }),
  });
  const services = {
    isSubAgent:  () => false,
    createStore: (ns: string) => (ns === 'jobs' ? store : new MemoryStore()),
    tools:       { register: (_t: Tool) => {} },
  } as unknown as MatbotMachine;

  const warn = console.warn;
  console.warn = () => {};
  try { await plugin.setup!(services); } finally { console.warn = warn; }
  await settle();
  tick(BOOT_GRACE_MS);                       // the arming grace
  await settle();
  if (staggerMs > 0) { tick(staggerMs); await settle(); }   // a recurring job's startup stagger
  return { ran, stop: async () => { await plugin.teardown?.(); } };
}

test('a suspend that lands while a job runs survives the stamp that follows it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const now  = new Date(Date.now()).toISOString();
  const inner = new MemoryStore<Row>();
  await inner.set('j', { id: 'j', version: 'v0', prompt: 'p', createdAt: now, nextRun: now, intervalMs: 1_000, active: true });

  // Suspended in the gap between the stamp's read and its write.
  const store = racing(inner, async i => {
    const cur = (await i.get('j'))!;
    await i.set('j', { ...cur, active: false, version: 'suspended' });
  });

  const { ran, stop } = await armed(store, { appended: 0, reply: '' }, ms => t.mock.timers.tick(ms), 1_000);
  try {
    assert.deepEqual(ran, ['j'], 'the job ran');
    const after = (await inner.get('j'))!;
    assert.equal(after.active, false, 'the suspend was not overwritten by the stamp that followed it');
    assert.ok(after.lastRun !== undefined, 'and the stamp still landed, re-applied to the suspended row');
  } finally {
    await stop();
  }
});

test('a cancel that lands while a job runs is not undone by the stamp', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const now  = new Date(Date.now()).toISOString();
  const inner = new MemoryStore<Row>();
  await inner.set('j', { id: 'j', version: 'v0', prompt: 'p', createdAt: now, nextRun: now, intervalMs: 1_000, active: true });

  // Cancelled in that same gap: the row is gone, and the stamp must not put it back.
  const store = racing(inner, async i => { await i.delete('j'); });

  const { ran, stop } = await armed(store, { appended: 0, reply: '' }, ms => t.mock.timers.tick(ms), 1_000);
  try {
    assert.deepEqual(ran, ['j']);
    assert.equal(await inner.get('j'), null, 'the cancelled row stayed deleted rather than being recreated');
  } finally {
    await stop();
  }
});

test('a one-shot whose run never started keeps its row, rather than losing the request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const store = new MemoryStore<Row>();
  await store.set('once', { id: 'once', version: 'v0', prompt: 'p', createdAt: past, nextRun: past, active: true });

  // `undefined` is the runner saying it could not start the job at all.
  const { ran, stop } = await armed(store, undefined, ms => t.mock.timers.tick(ms), 0);
  try {
    assert.deepEqual(ran, ['once'], 'it was attempted');
    assert.ok(await store.get('once') !== null, 'and its row survives, so the next boot tries it again');
  } finally {
    await stop();
  }
});

test('a one-shot that did run deletes itself', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const store = new MemoryStore<Row>();
  await store.set('once', { id: 'once', version: 'v0', prompt: 'p', createdAt: past, nextRun: past, active: true });

  const { ran, stop } = await armed(store, { appended: 1, reply: 'done' }, ms => t.mock.timers.tick(ms), 0);
  try {
    assert.deepEqual(ran, ['once']);
    assert.equal(await store.get('once'), null, 'a one-shot that ran is gone');
  } finally {
    await stop();
  }
});
