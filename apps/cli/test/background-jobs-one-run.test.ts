import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAs, installPrincipalCarrier } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import type { MatbotMachine, Store, Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';

// Several matbots share one job store — every open browser tab loads this plugin over the same IndexedDB —
// and each used to arm every stored job in a per-job loop of its own, so a job fired once per tab: N turns
// and N reports in the conversation. Two things followed from the loops being the authority on what is
// scheduled: a job created in one tab was armed only there, and orphaned when that tab closed; and a
// `resume` could only wake a loop in the tab that made it, so a job another tab held suspended slept for
// ever.
//
// There is no leader and no lock. The row is the schedule and `nextRun` is the claim: a scheduler
// compare-and-swaps the fire time of a due job, and runs it only if it won. The properties under test are
// that one occurrence is one run however many matbots are ticking, and that all four lifecycle operations
// cross from the matbot that wrote the row to the one that runs it.

installPrincipalCarrier(createAlsPrincipalCarrier());

const PRINCIPAL = { id: 'tester', type: 'user' as const };

interface Row {
  id: string; version: string; prompt: string; createdAt: string; nextRun: string;
  intervalMs?: number; active?: boolean; lastRun?: string; lastReply?: string;
}

type JobsModule = typeof import('../../../plugins/background-jobs/src/index.ts');

interface Realm {
  call: (tool: string, input: unknown) => Promise<Array<{ type: string; value?: unknown; message?: string }>>;
  stop: () => Promise<void>;
}

/**
 * One matbot, standing in for another browser tab or another process: this plugin loaded as a separate
 * module instance, so it has its own scheduler and its own in-flight map. The `?mbfresh=` stamp is
 * matbot's own hot-reload cache-buster; `plugin-api` and `core` are host-shared singletons and are
 * deliberately NOT re-stamped, so every realm here shares one store — which is the situation under test.
 *
 * `runs` collects `<realm>:<job id>` so a duplicate is distinguishable from one matbot running twice.
 */
async function realm(
  name: string, store: Store<Row>, runs: string[], runnable = true,
): Promise<Realm> {
  const { createBackgroundJobsPlugin } =
    await import(`../../../plugins/background-jobs/src/index.ts?mbfresh=${name}`) as JobsModule;

  const plugin = createBackgroundJobsPlugin({
    description: `test realm ${name}`,
    runner: () => (runnable
      ? { run: async job => { runs.push(`${name}:${job.id}`); return { appended: 1, reply: 'done' }; } }
      : undefined),
  });

  const services = {
    isSubAgent:  () => false,
    createStore: (ns: string) => (ns === 'jobs' ? store : new MemoryStore()),
    tools:       { register: (_t: Tool) => {} },
  } as unknown as MatbotMachine;

  const warn = console.warn;
  console.warn = () => {};
  try { await plugin.setup!(services); } finally { console.warn = warn; }

  const tools = new Map((plugin.tools ?? []).map((t: Tool) => [t.name, t]));
  const ctx   = { callId: 'c1', signal: new AbortController().signal, provider: 'test-provider' } as unknown as ToolContext;

  return {
    call: (tool, input) => runAs(PRINCIPAL, async () => {
      const events: Array<{ type: string; value?: unknown; message?: string }> = [];
      for await (const ev of tools.get(tool)!.executor.execute(input, ctx)) events.push(ev as never);
      return events;
    }),
    stop: async () => { await plugin.teardown?.(); },
  };
}

// The constants the scheduler is written to, restated here rather than exported: a test that moved with
// them would stop asserting anything about when a job may fire.
const BOOT_GRACE_MS        = 60_000;
const DISCOVERY_CEILING_MS = 60_000;
const BOOT_STAGGER_MS      = 10_000;

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r)); };

const row = (over: Partial<Row> & { id: string; nextRun: string }): Row => ({
  version: 'v0', prompt: 'p', createdAt: new Date(Date.now()).toISOString(), active: true, ...over,
});

const resultOf = (events: Array<{ type: string; value?: unknown }>): unknown =>
  events.find(e => e.type === 'result')?.value;

test('a job due on two matbots at once runs on exactly one of them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const store = new MemoryStore<Row>();
  await store.set('j', row({ id: 'j', nextRun: new Date(Date.now()).toISOString(), intervalMs: 1_000 }));

  const runs = ['first'].slice(1);
  const a = await realm('one-a', store, runs);
  const b = await realm('one-b', store, runs);
  try {
    t.mock.timers.tick(BOOT_GRACE_MS);                     // both schedulers' boot grace
    await settle();
    t.mock.timers.tick(BOOT_STAGGER_MS);                   // and the first tick's anti-pulse stagger
    await settle();

    assert.equal(runs.length, 1, `one occurrence is one run, not one per matbot (ran: ${runs.join(', ')})`);
    const after = (await store.get('j'))!;
    assert.ok(Date.parse(after.nextRun) > Date.now(), 'the claim carried the row past the occurrence it took');
    assert.ok(after.lastRun !== undefined, 'and stamped when the run started');
  } finally {
    await a.stop(); await b.stop();
  }
});

test('a job created in one matbot is run by another, and is not orphaned when its creator goes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const store = new MemoryStore<Row>();

  const runs = ['first'].slice(1);
  const a = await realm('orphan-a', store, runs);
  const b = await realm('orphan-b', store, runs);
  try {
    t.mock.timers.tick(BOOT_GRACE_MS);
    await settle();

    const created = resultOf(await a.call('background_job', { prompt: 'water the plants', interval: '1s' })) as { id: string };
    assert.ok(created.id, 'the tool returned a handle');
    assert.ok(await store.get(created.id) !== null, 'and wrote the row, which is all it does — it arms nothing');

    // Its creator's tab closes before the job is ever due. The row is the schedule, so the other matbot
    // finds it within the discovery ceiling; nothing had to be told.
    await a.stop();
    t.mock.timers.tick(DISCOVERY_CEILING_MS);
    await settle();

    assert.deepEqual(runs, [`orphan-b:${created.id}`], 'the surviving matbot ran it, once');
  } finally {
    await a.stop(); await b.stop();
  }
});

test('a resume in one matbot reaches the scheduler in another', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const store = new MemoryStore<Row>();
  const past  = new Date(Date.now() - 3_600_000).toISOString();
  await store.set('j', row({ id: 'j', nextRun: past, intervalMs: 1_000, active: false }));

  const runs = ['first'].slice(1);
  // `writer` cannot run a job at all, so it has no scheduler: whatever happens, happens in `ticker`.
  const writer = await realm('resume-w', store, runs, false);
  const ticker = await realm('resume-t', store, runs);
  try {
    t.mock.timers.tick(BOOT_GRACE_MS);
    await settle();
    assert.equal(runs.length, 0, 'a suspended job is owed nothing');

    await writer.call('background_job_action', { action: 'resume', id: 'j' });
    await settle();
    assert.equal((await store.get('j'))!.active, true, 'the resume is a row write, and landed');
    assert.equal(runs.length, 0, 'the other matbot has not ticked yet');

    t.mock.timers.tick(DISCOVERY_CEILING_MS);
    await settle();
    assert.deepEqual(runs, ['resume-t:j'], 'and picked the resume up on its next tick, once');
  } finally {
    await writer.stop(); await ticker.stop();
  }
});

test('a job overdue by many intervals runs once, not once per interval it missed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const store = new MemoryStore<Row>();
  // Ten minutes of missed 1s occurrences: matbot was simply not running.
  const past = new Date(Date.now() - 600_000).toISOString();
  await store.set('j', row({ id: 'j', nextRun: past, intervalMs: 1_000 }));

  const runs = ['first'].slice(1);
  const only = await realm('catchup', store, runs);
  try {
    t.mock.timers.tick(BOOT_GRACE_MS);
    await settle();
    t.mock.timers.tick(BOOT_STAGGER_MS);
    await settle();

    // The claim advances to the next occurrence AFTER now, so the row is not still due and the tick that
    // follows does not claim it again. Advancing by one interval would have queued 600 catch-up runs.
    assert.deepEqual(runs, ['catchup:j'], 'one run for a downtime, not one per occurrence missed');
    assert.ok(Date.parse((await store.get('j'))!.nextRun) > Date.now());
  } finally {
    await only.stop();
  }
});

test('a cancel in one matbot stops the schedule for all of them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const store = new MemoryStore<Row>();
  const soon  = new Date(Date.now() + 30_000).toISOString();
  await store.set('j', row({ id: 'j', nextRun: soon, intervalMs: 30_000 }));

  const runs = ['first'].slice(1);
  const a = await realm('cancel-a', store, runs);
  const b = await realm('cancel-b', store, runs);
  try {
    t.mock.timers.tick(BOOT_GRACE_MS);
    await settle();
    await a.call('background_job_action', { action: 'cancel', id: 'j' });
    await settle();
    assert.equal(await store.get('j'), null);

    t.mock.timers.tick(DISCOVERY_CEILING_MS * 2);
    await settle();
    assert.deepEqual(runs, [], 'a cancelled row is a cancelled schedule in every matbot, with nothing to tell');
  } finally {
    await a.stop(); await b.stop();
  }
});
