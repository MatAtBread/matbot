import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyError, runAs, installPrincipalCarrier } from '@matatbread/matbot-core';
import { executeQuery } from '@matatbread/matbot-core/storage-base';
import type { MatbotMachine, Store, ToolContext } from '@matatbread/matbot-plugin-api';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';
import { plugin as backgroundPlugin } from '../../../plugins/background/src/index.ts';

// `every_action({ action: 'suspend', id: '*' })` sweeps the schedules store and `set`s each document. The
// same exposure `compact_sessions` had, one namespace over — `schedules` is isolatable like any other, so a
// schedule shared in read-only refuses the write — but with a worse ending: the throw escaped the executor
// after the loop had already flipped and woken the schedules before it, so the caller was told the whole
// operation failed while some of it had happened. A partial mutation reported as a total failure is the one
// outcome you cannot recover from by retrying.
installPrincipalCarrier(createAlsPrincipalCarrier());

const READ_ONLY = 'shared-in-schedule';

type Sched = { id: string; version: string; active?: boolean; intervalMs: number; interval: string; prompt: string };

// The unwritable one sits in the MIDDLE deliberately: before the fix, `mine-a` was already flipped and
// woken when the throw discarded the report, which is the partial-mutation half of the bug.
const seed = (): Sched[] => [
  { id: 'mine-a',  version: 'v', active: true, intervalMs: 3_600_000, interval: '1h', prompt: 'p' },
  { id: READ_ONLY, version: 'v', active: true, intervalMs: 3_600_000, interval: '1h', prompt: 'p' },
  { id: 'mine-b',  version: 'v', active: true, intervalMs: 3_600_000, interval: '1h', prompt: 'p' },
];

function machine(): { services: MatbotMachine; store: Store<Sched>; written: string[] } {
  const docs    = new Map(seed().map(d => [d.id, d]));
  const written: string[] = [];
  const store = {
    async get(id: string) { return docs.get(id) ?? null; },
    async set(id: string, v: Sched) {
      if (id === READ_ONLY) throw readOnlyError('schedules', id, 'global');
      written.push(id); docs.set(id, v);
    },
    async cas(id: string, _e: string, next: Sched) {
      if (id === READ_ONLY) throw readOnlyError('schedules', id, 'global');
      written.push(id); docs.set(id, next); return { ok: true as const, doc: next };
    },
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
  return { services, store, written };
}

async function suspendAll(mangle?: (s: Store<Sched>) => Store<Sched>): Promise<{ ev: { type: string; value?: unknown; message?: string }; written: string[] }> {
  const m = machine();
  const { written } = m;
  const services = mangle === undefined ? m.services
    : { ...m.services, createStore: () => mangle(m.store) } as unknown as MatbotMachine;
  await backgroundPlugin.setup?.(services);
  try {
    const tool = backgroundPlugin.tools!.find(t => t.name === 'every_action')!;
    const ev = await runAs({ id: 'matt', type: 'user' }, async () => {
      for await (const e of tool.executor.execute({ action: 'suspend', id: '*' }, {} as unknown as ToolContext)) {
        if (e.type === 'result' || e.type === 'error') return e as { type: string; value?: unknown; message?: string };
      }
      throw new Error('every_action yielded no result');
    });
    return { ev, written };
  } finally {
    await backgroundPlugin.teardown?.();
  }
}

test('suspending every schedule skips one it cannot write and still reports what it did', async () => {
  const { ev, written } = await suspendAll();

  assert.equal(ev.type, 'result', `the sweep must complete, not throw: ${String(ev.message)}`);
  assert.deepEqual(written.sort(), ['mine-a', 'mine-b'], 'every writable schedule is suspended');

  const value = ev.value as { suspended: true; count: number; ids: string[]; skipped?: Array<{ id: string; reason: string }> };
  assert.deepEqual(value.ids.sort(), ['mine-a', 'mine-b']);
  assert.equal(value.count, 2, 'count reports what changed, not what was examined');

  // Silence here would be the whole bug in a milder form: the caller asked for "all" and did not get all.
  assert.ok(value.skipped, 'a schedule that could not be suspended must be reported');
  assert.equal(value.skipped.length, 1);
  assert.equal(value.skipped[0]?.id, READ_ONLY);
  assert.match(String(value.skipped?.[0]?.reason), /read-only/i);
  assert.match(String(value.skipped?.[0]?.reason), /global/, 'naming the owner is the actionable half');
});

test('a fault that is not a per-operation refusal still stops the sweep', async () => {
  // The counterpart to the skip, and why it tests for the brand rather than catching everything: a broken
  // backend reported as a cosmetic `skipped` row would have the tool announce that it suspended what it
  // could, when in fact nothing is running as described.
  await assert.rejects(
    () => suspendAll(store => ({ ...store, async set(id: string, v: never) {
      if (id === 'mine-b') throw new Error('backend is on fire');
      return store.set(id, v);
    } }) as unknown as Store<Sched>),
    /backend is on fire/,
  );
});
