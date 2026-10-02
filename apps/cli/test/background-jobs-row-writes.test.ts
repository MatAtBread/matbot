import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASResult, MatbotMachine, QueryResult, Store, StoreQuery, Tool } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { createBackgroundJobsPlugin, BOOT_GRACE_MS } from '../../../plugins/background-jobs/src/index.ts';

// A job row has several writers and they race each other: a scheduler CLAIMING a due job (which is how a
// job is taken for one matbot and not another — it advances `nextRun`), the run recording what it printed
// as `lastReply`, a `suspend` flipping `active`, a `cancel` deleting it. The property under test is that
// no writer of a row overwrites a document it has not read — once a plain `set` built from a read taken
// before the run finished, which erased whatever landed in between: a suspend undone, and a CANCELLED row
// written back, to be run again on the next boot.
//
// The two writers pull in opposite directions, deliberately. The claim is a bare `cas` and does NOT retry:
// a lost swap there means the row changed under it, and re-applying the claim is exactly the duplicate run
// it exists to prevent — so a suspend or a cancel that lands first stops the run outright. What the run
// leaves behind afterwards is a retrying `mutate`: losing that costs a post-mortem, not a run, so it
// re-reads and composes onto whatever it finds.
//
// And that a one-shot is deleted because it RAN, not merely because it was reached: a run that could not
// start (no provider to run as, a failed spawn — the runner reports `undefined`) used to delete the row
// anyway, losing a scheduled request outright, unrun and unreported, for a usually-transient condition.

interface Row {
  id: string; version: string; prompt: string; createdAt: string; nextRun: string;
  intervalMs?: number; active?: boolean; lastRun?: string; lastReply?: string;
}

/**
 * The jobs store, with a one-shot hook that fires just before the `fireOn`-th write to reach it — standing
 * in for another writer landing in the gap between that writer's read and its write. `fireOn: 1` is the
 * claim; `fireOn: 2` is what the run leaves behind once the claim has won. The competing write goes
 * straight to `inner`, so it does not re-enter the hook.
 */
function racing(inner: Store<Row>, fireOn: number, competing: (inner: Store<Row>) => Promise<void>): Store<Row> {
  let writes = 0;
  let armed  = true;
  const fire = async (): Promise<void> => {
    if (armed && ++writes === fireOn) { armed = false; await competing(inner); }
  };
  return {
    get:    (id: string) => inner.get(id),
    query:  (q: StoreQuery) => inner.query(q) as Promise<QueryResult<Row>>,
    delete: (id: string, v?: string) => inner.delete(id, v),
    async set(id: string, value: Row): Promise<void> { await fire(); return inner.set(id, value); },
    async cas(id: string, expected: string, next: Row): Promise<CASResult<Row>> { await fire(); return inner.cas(id, expected, next); },
  };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

// Boot the plugin over `store` with a runner whose every run resolves to `outcome`, and let the boot grace
// and the first tick's anti-pulse stagger elapse. Returns a teardown.
async function booted(
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
  tick(BOOT_GRACE_MS);                       // the boot grace
  await settle();
  if (staggerMs > 0) { tick(staggerMs); await settle(); }   // a recurring job's first-tick stagger
  return { ran, stop: async () => { await plugin.teardown?.(); } };
}

test('a suspend that lands before the claim stops the run outright', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const now  = new Date(Date.now()).toISOString();
  const inner = new MemoryStore<Row>();
  await inner.set('j', { id: 'j', version: 'v0', prompt: 'p', createdAt: now, nextRun: now, intervalMs: 1_000, active: true });

  // Suspended in the gap between the tick's read and its claim.
  const store = racing(inner, 1, async i => {
    const cur = (await i.get('j'))!;
    await i.set('j', { ...cur, active: false, version: 'suspended' });
  });

  const { ran, stop } = await booted(store, { appended: 0, reply: '' }, ms => t.mock.timers.tick(ms), 1_000);
  try {
    assert.deepEqual(ran, [], 'the claim lost, so the job was never this matbot\'s to run');
    const after = (await inner.get('j'))!;
    assert.equal(after.active, false, 'and the suspend stands, un-overwritten');
    assert.equal(after.version, 'suspended', 'the claim did not land on top of it');
  } finally {
    await stop();
  }
});

test('a cancel that lands before the claim is not undone by it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const now  = new Date(Date.now()).toISOString();
  const inner = new MemoryStore<Row>();
  await inner.set('j', { id: 'j', version: 'v0', prompt: 'p', createdAt: now, nextRun: now, intervalMs: 1_000, active: true });

  // Cancelled in that same gap: the row is gone, and the claim must not put it back.
  const store = racing(inner, 1, async i => { await i.delete('j'); });

  const { ran, stop } = await booted(store, { appended: 0, reply: '' }, ms => t.mock.timers.tick(ms), 1_000);
  try {
    assert.deepEqual(ran, []);
    assert.equal(await inner.get('j'), null, 'the cancelled row stayed deleted rather than being recreated');
  } finally {
    await stop();
  }
});

test('a suspend that lands while a job runs survives what the run leaves behind', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const now  = new Date(Date.now()).toISOString();
  const inner = new MemoryStore<Row>();
  await inner.set('j', { id: 'j', version: 'v0', prompt: 'p', createdAt: now, nextRun: now, intervalMs: 1_000, active: true });

  // The claim is write 1 and wins; this lands in the gap before the run records its reply.
  const store = racing(inner, 2, async i => {
    const cur = (await i.get('j'))!;
    await i.set('j', { ...cur, active: false, version: 'suspended' });
  });

  const { ran, stop } = await booted(store, { appended: 0, reply: 'what it said' }, ms => t.mock.timers.tick(ms), 1_000);
  try {
    assert.deepEqual(ran, ['j'], 'the job ran');
    const after = (await inner.get('j'))!;
    assert.equal(after.active, false, 'the suspend was not overwritten by the write that followed it');
    assert.equal(after.lastReply, 'what it said', 'and that write still landed, re-applied to the suspended row');
  } finally {
    await stop();
  }
});

test('a cancel that lands while a job runs is not undone by what it leaves behind', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const now  = new Date(Date.now()).toISOString();
  const inner = new MemoryStore<Row>();
  await inner.set('j', { id: 'j', version: 'v0', prompt: 'p', createdAt: now, nextRun: now, intervalMs: 1_000, active: true });

  const store = racing(inner, 2, async i => { await i.delete('j'); });

  const { ran, stop } = await booted(store, { appended: 0, reply: 'what it said' }, ms => t.mock.timers.tick(ms), 1_000);
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
  const { ran, stop } = await booted(store, undefined, ms => t.mock.timers.tick(ms), 0);
  try {
    assert.deepEqual(ran, ['once'], 'it was attempted');
    const after = await store.get('once');
    assert.ok(after !== null, 'and its row survives, so a later tick tries it again');
    // The claim pushed its fire time out rather than deleting it: that window, not a lease, is what lets
    // another matbot re-run a one-shot whose claimer died mid-run.
    assert.ok(Date.parse(after.nextRun) > Date.now(), 'with its fire time moved out by the claim');
  } finally {
    await stop();
  }
});

test('a one-shot that did run deletes itself', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const store = new MemoryStore<Row>();
  await store.set('once', { id: 'once', version: 'v0', prompt: 'p', createdAt: past, nextRun: past, active: true });

  const { ran, stop } = await booted(store, { appended: 1, reply: 'done' }, ms => t.mock.timers.tick(ms), 0);
  try {
    assert.deepEqual(ran, ['once']);
    assert.equal(await store.get('once'), null, 'a one-shot that ran is gone');
  } finally {
    await stop();
  }
});
