import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediumGuard } from '@matatbread/matbot-core/storage-base';
import type { Store, CASResult, QueryResult } from '@matatbread/matbot-core';

// Exactly one StorageBackend is active and nothing is migrated between them, so a read from one and a
// write to another moves a document between media — silently, because compare-and-swap compares the
// document, not the medium it came from. The new backend answers "there is nothing here", which reads
// as "you may create it".

interface Doc { id: string; version: string; title: string }

function memStore(seed: Doc[] = []): Store<Doc> & { docs: Map<string, Doc> } {
  const docs = new Map<string, Doc>(seed.map(d => [d.id, d]));
  return {
    docs,
    get: async id => docs.get(id) ?? null,
    set: async (id, v) => { docs.set(id, v); },
    async cas(id, expected, next): Promise<CASResult<Doc>> {
      const cur = docs.get(id) ?? null;
      if (cur?.version !== expected) return { ok: false, current: cur };
      docs.set(id, next);
      return { ok: true, doc: next };
    },
    delete: async (id, expectedVersion) => {
      const cur = docs.get(id);
      if (cur === undefined || (expectedVersion !== undefined && cur.version !== expectedVersion)) return false;
      docs.delete(id);
      return true;
    },
    query: async (): Promise<QueryResult<Doc>> => ({ items: [...docs.values()], total: docs.size }),
  };
}

test('a write cannot cross a backend swap', async () => {
  const before = memStore([{ id: 'a', version: 'v1', title: 'original' }]);
  const after  = memStore();                       // the replacement holds nothing: nothing is migrated

  let generation = 0;
  let backing: Store<Doc> = before;
  // Stands in for the swap proxy: one stable store object, repointed underneath.
  const proxy: Store<Doc> = {
    get:    (...a) => backing.get(...a),
    set:    (...a) => backing.set(...a),
    cas:    (...a) => backing.cas(...a),
    delete: (...a) => backing.delete(...a),
    query:  (...a) => backing.query(...a),
  };
  const store = mediumGuard<Doc>(proxy, () => generation, 'docs');

  const read = (await store.get('a'))!;
  assert.equal(read.title, 'original');

  backing = after; generation++;                   // register('StorageBackend', …) landing at the edge

  // The turn's unconditional write-back is the shape that migrates a session: without the guard this
  // recreates the document, whole, in a backend that never held it.
  await assert.rejects(store.set('a', { ...read, title: 'written after the swap' }), /generation 0.*generation 1/s);
  assert.equal(after.docs.size, 0, 'nothing was moved into the replacement');

  // CAS reports it the way callers already handle — someone else got there first, the medium being
  // the someone else — rather than throwing.
  const res = await store.cas('a', read.version, { ...read, version: 'v2', title: 'also after' });
  assert.equal(res.ok, false);
  assert.equal(after.docs.size, 0);

  // A document minted rather than read carries no stamp, so creating one in the new backend is fine.
  await store.set('b', { id: 'b', version: 'fresh', title: 'created here' });
  assert.equal(after.docs.get('b')!.title, 'created here');
});

test('the stamp never reaches the backend, and survives a read-modify-write', async () => {
  const backend = memStore([{ id: 'a', version: 'v1', title: 'original' }]);
  const store   = mediumGuard<Doc>(backend, () => 3, 'docs');

  const read = (await store.get('a'))!;
  assert.notEqual(read.version, 'v1', 'the caller sees a stamped version');

  // The common write-back: same version, changed field. A persisted stamp would be stamped again on
  // the next read, so what lands must be the bare version.
  await store.set('a', { ...read, title: 'renamed' });
  assert.deepEqual(backend.docs.get('a'), { id: 'a', version: 'v1', title: 'renamed' });

  // CAS round-trips the stamped version the caller was given, and the backend still sees the bare one.
  const res = await store.cas('a', read.version, { ...read, version: 'v2', title: 'again' });
  assert.ok(res.ok);
  assert.deepEqual(backend.docs.get('a'), { id: 'a', version: 'v2', title: 'again' });
  assert.equal((await store.get('a'))!.version, 'm3~v2', 'one stamp, not two');

  // query hands out stamped documents too — they are read the same way and written back the same way.
  const page = await store.query({});
  assert.equal(page.items[0]!.version, 'm3~v2');

  assert.equal(await store.delete('a', (await store.get('a'))!.version), true);
});
