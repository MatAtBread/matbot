import { test } from 'node:test';
import assert from 'node:assert/strict';
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
