import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAs, installPrincipalCarrier } from '@matatbread/matbot-core';
import { executeQuery } from '@matatbread/matbot-core/storage-base';
import type { MatbotMachine, Store, Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';
import { plugin as backgroundPlugin } from '../../../plugins/background/src/index.ts';

// `background` grew a third timing: `at`, a single run at a stated time. It is a persisted schedule like
// a recurring one — it has to survive a restart to be worth anything — but with no interval, which is
// what marks it a one-shot (a separate flag could disagree with the interval beside it).
//
// What is NOT exercised here is the firing itself: `spawnJob` re-launches `argv[1]`, which under the test
// runner is this very file, so a test that let a due one-shot fire would spawn the suite. Every schedule
// created below is therefore in the future, and teardown aborts its timer.

installPrincipalCarrier(createAlsPrincipalCarrier());

const PRINCIPAL = { id: 'tester', type: 'user' as const };

type Sched = { id: string; version: string; prompt: string; nextRun: string; intervalMs?: number; active?: boolean; name?: string };

async function harness() {
  const docs = new Map<string, Sched>();
  const store = {
    async get(id: string) { return docs.get(id) ?? null; },
    async set(id: string, v: Sched) { docs.set(id, v); },
    async cas(id: string, _e: string, next: Sched) { docs.set(id, next); return { ok: true as const, doc: next }; },
    async delete(id: string) { return docs.delete(id); },
    async query(q: unknown) { return executeQuery([...docs.values()], q as never); },
  } as unknown as Store<Sched>;

  const services = {
    configPath:  '/nowhere/matbot.yaml',
    isSubAgent:  () => false,
    createStore: () => store,
    files:       undefined,
    Notifier:    { notify: () => {}, consume: () => {} },
  } as unknown as MatbotMachine;

  await backgroundPlugin.setup!(services);

  const tools = new Map((backgroundPlugin.tools ?? []).map((t: Tool) => [t.name, t]));
  const ctx   = { callId: 'c1', signal: new AbortController().signal, provider: 'test-provider' } as unknown as ToolContext;

  const call = (name: string, input: unknown) => runAs(PRINCIPAL, async () => {
    const events: Array<{ type: string; value?: unknown; message?: string }> = [];
    for await (const ev of tools.get(name)!.executor.execute(input, ctx)) events.push(ev as never);
    return events;
  });

  return { call, docs, done: () => backgroundPlugin.teardown?.() };
}

const resultOf = (events: Array<{ type: string; value?: unknown }>) => events.find(e => e.type === 'result')?.value;
const errorOf  = (events: Array<{ type: string; message?: string }>) => events.find(e => e.type === 'error')?.message ?? '';

test('a duration is resolved to an absolute instant, and the caller is told which', async () => {
  const { call, docs, done } = await harness();
  try {
    const before = Date.now();
    const value  = resultOf(await call('background', { prompt: 'water the plants', at: '90m', name: 'plants' })) as
      { id: string; at: string; name?: string };

    assert.ok(value.id, 'a timed job must return a handle for every_action');
    assert.equal(value.name, 'plants');
    const at = Date.parse(value.at);
    // Echoed as an instant, not as the words it was given: a user told "in 90 minutes" cannot check it,
    // and the model is the only party that saw what it typed.
    assert.ok(at >= before + 90 * 60_000 && at <= Date.now() + 90 * 60_000, `resolved to ${value.at}`);

    const stored = docs.get(value.id)!;
    assert.equal(stored.nextRun, value.at);
    assert.equal(stored.intervalMs, undefined, 'the absence of an interval is what makes it a one-shot');
    assert.equal(stored.prompt, 'water the plants');
  } finally { await done(); }
});

test('an ISO date-time is taken as given; a bare date is midnight UTC', async () => {
  const { call, docs, done } = await harness();
  try {
    const exact = resultOf(await call('background', { prompt: 'p', at: '2099-08-23T09:00:00Z' })) as { id: string; at: string };
    assert.equal(exact.at, '2099-08-23T09:00:00.000Z');

    const midnight = resultOf(await call('background', { prompt: 'p', at: '2099-08-23' })) as { id: string; at: string };
    assert.equal(midnight.at, '2099-08-23T00:00:00.000Z');
    assert.equal(docs.size, 2);
  } finally { await done(); }
});

test('a time already past is refused rather than run instantly', async () => {
  const { call, docs, done } = await harness();
  try {
    // The failure this guards is a model that got the year wrong: firing immediately looks exactly like
    // the tool having ignored the time it was handed.
    const events = await call('background', { prompt: 'p', at: '2020-01-01T00:00:00Z' });
    assert.match(errorOf(events), /in the past/);
    assert.match(errorOf(events), /2020-01-01/);
    assert.equal(docs.size, 0, 'a refused schedule must not be stored');
  } finally { await done(); }
});

test('an unparseable time names the two forms that work', async () => {
  const { call, docs, done } = await harness();
  try {
    for (const at of ['tomorrow', '9am', '5']) {
      const events = await call('background', { prompt: 'p', at });
      assert.match(errorOf(events), /ISO-8601/, `"${at}" should be refused`);
      assert.match(errorOf(events), /duration from now/);
    }
    // "5" specifically: Date.parse reads it as a year, so an unguarded parse would schedule a job for
    // the year 2005 — refused above, not silently accepted.
    assert.equal(docs.size, 0);
  } finally { await done(); }
});

test('interval and at together are refused — they are different jobs, not a combination', async () => {
  const { call, docs, done } = await harness();
  try {
    const events = await call('background', { prompt: 'p', at: '90m', interval: '1h' });
    assert.match(errorOf(events), /not both/);
    assert.equal(docs.size, 0);
  } finally { await done(); }
});

test('every_action lists a one-shot as "once", with its fire time', async () => {
  const { call, done } = await harness();
  try {
    const once  = resultOf(await call('background', { prompt: 'p', at: '2099-08-23T09:00:00Z', name: 'later' })) as { id: string };
    const every = resultOf(await call('background', { prompt: 'p', interval: '1h' })) as { id: string };

    const rows = resultOf(await call('every_action', { action: 'list' })) as
      Array<{ id: string; interval: string; nextRun: string; active: boolean; name?: string }>;

    const oneShot   = rows.find(r => r.id === once.id)!;
    const recurring = rows.find(r => r.id === every.id)!;
    assert.equal(oneShot.interval, 'once');
    assert.equal(oneShot.nextRun, '2099-08-23T09:00:00.000Z');
    assert.equal(oneShot.name, 'later');
    assert.equal(recurring.interval, '1h');

    // The same handle manages both kinds: a one-shot the user changed their mind about is cancellable.
    const cancelled = resultOf(await call('every_action', { action: 'cancel', id: once.id })) as { cancelled: boolean };
    assert.equal(cancelled.cancelled, true);
    const after = resultOf(await call('every_action', { action: 'list' })) as Array<{ id: string }>;
    assert.deepEqual(after.map(r => r.id), [every.id]);
  } finally { await done(); }
});
