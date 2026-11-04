import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPrincipalCarrier, isReadOnlyError, runAs } from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '@matatbread/matbot-host-node';
import { ProfilesStorageBackend } from '@matatbread/matbot-storage-profiles';
import type { MatbotMachine, Store } from '@matatbread/matbot-plugin-api';
import { TriggerManager } from '../../../plugins/triggers/src/index.ts';
import type { Trigger } from '../../../plugins/triggers/src/index.ts';

// `ephemeral` was `augment` before 0.5.0. A stored trigger still carrying the old name was judged on no
// surface, so it never fired and nothing said so.

function memoryStore(docs: Map<string, Trigger>, casFails = false): Store<Trigger> {
  return {
    query:  async () => ({ items: [...docs.values()] }),
    get:    async (id: string) => docs.get(id) ?? null,
    set:    async (id: string, doc: Trigger) => { docs.set(id, doc); },
    cas:    async (id: string, version: string, doc: Trigger) => {
      if (casFails || docs.get(id)?.version !== version) return { ok: false, current: docs.get(id) ?? null };
      docs.set(id, doc);
      return { ok: true, doc };
    },
    delete: async (id: string) => docs.delete(id),
  } as unknown as Store<Trigger>;
}

const old = (): Trigger => ({
  id: 't1', version: 'v0', enabled: true,
  conditions: [{ kind: 'augment' as Trigger['conditions'][number]['kind'], rule: 'asks about dwell' }, { kind: 'followup', rule: 'x' }],
  invoke: { tool: 'contextual_search', params: { q: 'dwell' } },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

async function warnings(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const warn = console.warn;
  console.warn = (m: unknown) => { seen.push(String(m)); };
  try { await fn(); } finally { console.warn = warn; }
  return seen;
}

test('an augment condition is read as ephemeral, stored so, and said', async () => {
  const docs = new Map([['t1', old()]]);
  const manager = new TriggerManager(memoryStore(docs), {} as MatbotMachine);
  let all: Trigger[] = [];
  const warned = await warnings(async () => { all = await manager.all(); });
  assert.deepEqual(all[0]!.conditions.map(c => c.kind), ['ephemeral', 'followup']);
  assert.deepEqual(docs.get('t1')!.conditions.map(c => c.kind), ['ephemeral', 'followup'], 'written back');
  assert.ok(warned.some(m => /"t1".*"augment".*now stored as "ephemeral"/.test(m)));
  assert.deepEqual(await warnings(async () => { await manager.get('t1'); }), [], 'nothing left to say once it is stored');
});

test('when the write-back loses, it is still read as ephemeral, and said again on the next read', async () => {
  const docs = new Map([['t1', old()]]);
  const manager = new TriggerManager(memoryStore(docs, true), {} as MatbotMachine);
  let got: Trigger | undefined;
  const warned = await warnings(async () => { got = await manager.get('t1'); });
  assert.equal(got!.conditions[0]!.kind, 'ephemeral');
  assert.equal(docs.get('t1')!.conditions[0]!.kind as string, 'augment');
  assert.ok(warned.some(m => /will be stored so when it next can be/.test(m)));
});

test('a write-back that throws costs that write and no read: every other trigger still comes back', async () => {
  const fine: Trigger = { ...old(), id: 't2', conditions: [{ kind: 'followup', rule: 'x' }] };
  const docs = new Map<string, Trigger>([['t1', old()], ['t2', fine]]);
  const store = memoryStore(docs);
  store.cas = (async () => { throw new Error('disk full'); }) as typeof store.cas;
  const manager = new TriggerManager(store, {} as MatbotMachine);
  let all: Trigger[] = [];
  const warned = await warnings(async () => { all = await manager.all(); });
  assert.deepEqual(all.map(t => [t.id, t.conditions[0]!.kind]), [['t1', 'ephemeral'], ['t2', 'followup']]);
  assert.ok(warned.some(m => /"t1".*will be stored so when it next can be.*disk full/.test(m)), warned.join('\n'));
  assert.equal((await manager.get('t1'))?.conditions[0]!.kind, 'ephemeral');
  assert.equal((await manager.query({ tool: 'contextual_search' })).length, 2);
});

test('under a profiles backend, a shared trigger still stored as augment is read, and is not this principal\'s to write', async () => {
  installPrincipalCarrier(createAlsPrincipalCarrier());
  const dir = await mkdtemp(join(tmpdir(), 'matbot-trigger-kind-'));
  const backend = await ProfilesStorageBackend.open(dir);
  try {
    await backend.createProfile('owner', ['triggers']);
    await backend.createProfile('viewer', ['triggers']);
    const store = backend.createStore('triggers') as unknown as Store<Trigger>;
    await runAs({ id: 'owner', type: 'user' }, async () => {
      await store.set('t1', old());
      await backend.share('triggers', 't1', 'viewer');
    });
    await runAs({ id: 'viewer', type: 'user' }, async () => {
      await store.set('mine', { ...old(), id: 'mine', conditions: [{ kind: 'followup', rule: 'x' }] });
      // The premise: this really is the refusal a principal gets for someone else's document.
      await assert.rejects(store.cas('t1', (await store.get('t1'))!.version, { ...old(), version: 'v1' }), isReadOnlyError);
      const manager = new TriggerManager(store, {} as MatbotMachine);
      let all: Trigger[] = [];
      await warnings(async () => { all = await manager.all(); });
      assert.deepEqual(all.map(t => t.id).sort(), ['mine', 't1'], 'the viewer\'s own triggers are not lost with it');
      assert.equal(all.find(t => t.id === 't1')!.conditions[0]!.kind, 'ephemeral');
    });
    await runAs({ id: 'owner', type: 'user' }, async () => {
      assert.equal((await store.get('t1'))!.conditions[0]!.kind as string, 'augment', 'left for its owner to migrate');
      const manager = new TriggerManager(store, {} as MatbotMachine);
      await warnings(async () => { await manager.all(); });
      assert.equal((await store.get('t1'))!.conditions[0]!.kind, 'ephemeral', 'which its owner\'s next read does');
    });
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});
