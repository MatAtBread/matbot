import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CachingStorageBackend } from '@matatbread/matbot-core/storage-base';
import { installPrincipalCarrier, runAs } from '@matatbread/matbot-core';
import type { StorageBackend } from '@matatbread/matbot-plugin-api';
import { FilesystemStorageBackend } from '../../../plugins/storage/filesystem/src/backend.ts';
import { SQLiteStorageBackend }     from '../../../plugins/storage/sqlite/src/backend.ts';
import { ProfilesStorageBackend }   from '../../../plugins/storage/profiles/src/backend.ts';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';

// `StorageBackend.createStore` is addressed BY name, so a backend could only ever be read by a caller
// that already knew what to ask for. `namespaces()` is what makes one traversable — copying a backend
// into another, auditing what is stored — and the contract it has to hold is the same for every
// implementation, so it is asserted here once against each.
//
// The property that matters is that the answer is TRUE, not merely plausible: a traversal built on a
// list that includes a namespace holding nothing, or omits one holding something, fails silently and
// reports success. Each backend reaches it differently — the filesystem cannot tell a store directory
// from any other directory by name, and SQLite cannot recover a namespace from its own table name —
// so the shared corpus is the only thing that keeps them agreeing.

installPrincipalCarrier(createAlsPrincipalCarrier());

const seeded = ['sessions', 'skills', 'remembered_facts'];

async function seed(backend: StorageBackend): Promise<void> {
  for (const ns of seeded) {
    await backend.createStore(ns).set('one', { id: 'one', version: 'v1' });
  }
  // Opened but never written: `namespaces()` reports what HOLDS documents, so this must not appear.
  backend.createStore('untouched');
}

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-namespaces-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const backends: Array<[string, (dir: string) => Promise<StorageBackend>]> = [
  ['filesystem', d => FilesystemStorageBackend.open(d)],
  ['sqlite',     d => SQLiteStorageBackend.open(d)],
  ['caching over filesystem', async d => new CachingStorageBackend(await FilesystemStorageBackend.open(d))],
  ['profiles over filesystem', d => ProfilesStorageBackend.open(d)],
];

for (const [label, open] of backends) {
  test(`${label}: reports the namespaces holding documents, sorted, and nothing else`, async () => {
    await withTemp(async dir => {
      const backend = await open(dir);
      try {
        await seed(backend);
        const found = await backend.namespaces!();
        assert.deepEqual(found, [...seeded].sort(), 'must be exactly the written namespaces, sorted');
        assert.ok(!found.includes('untouched'), 'an opened-but-empty store holds nothing to traverse');
      } finally { await backend.close?.(); }
    });
  });

  test(`${label}: an untouched backend reports nothing rather than failing`, async () => {
    await withTemp(async dir => {
      const backend = await open(dir);
      try { assert.deepEqual(await backend.namespaces!(), []); }
      finally { await backend.close?.(); }
    });
  });
}

// The filesystem backend shares `.data` with anything that wants a directory there, and cannot tell a
// store from a plugin's working state by name — so the test is what the directory CONTAINS.
test('filesystem: a directory that holds no documents is not a namespace', async () => {
  await withTemp(async dir => {
    const backend = await FilesystemStorageBackend.open(dir);
    await seed(backend);

    await mkdir(join(dir, 'bash-cwd'), { recursive: true });                 // a plugin's working state
    await writeFile(join(dir, 'bash-cwd', 'cwd'), '/tmp');                   // not a document
    await mkdir(join(dir, 'nested', 'deeper'), { recursive: true });         // documents one level down
    await writeFile(join(dir, 'nested', 'deeper', 'x.json'), '{}');
    await mkdir(join(dir, 'files'), { recursive: true });                    // the blob area
    await writeFile(join(dir, 'files', 'looks-like.json'), '{}');            // a stored file, not a doc

    assert.deepEqual(await backend.namespaces(), [...seeded].sort());
  });
});

// A namespace's characters do not survive the derivation of a SQLite table name, so the table alone
// cannot answer — `a-b` and `a_b` both yield `a_b_store`.
test('sqlite: a namespace with punctuation round-trips through the registry', async () => {
  await withTemp(async dir => {
    const backend = await SQLiteStorageBackend.open(dir);
    try {
      await backend.createStore('my-odd.ns').set('one', { id: 'one', version: 'v1' });
      assert.deepEqual(await backend.namespaces(), ['my-odd.ns'], 'the namespace, not the table name');
    } finally { await backend.close?.(); }
  });
});

test('sqlite: tables predating the registry are still enumerated', async () => {
  await withTemp(async dir => {
    const first = await SQLiteStorageBackend.open(dir);
    await first.createStore('sessions').set('one', { id: 'one', version: 'v1' });
    await first.close?.();

    // Drop the registry to reproduce a database written before it existed.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(join(dir, 'matbot.db'));
    raw.exec('DROP TABLE namespace_registry');
    raw.close();

    const reopened = await SQLiteStorageBackend.open(dir);
    try { assert.deepEqual(await reopened.namespaces(), ['sessions'], 'backfilled from the table name'); }
    finally { await reopened.close?.(); }
  });
});

// Partitioning exists to keep one principal from reading another's data; enumerating has to respect
// that, or it reports a namespace as present that a read would not return.
test('profiles: an isolated namespace is reported only to the principal that owns it', async () => {
  await withTemp(async dir => {
    const backend = await ProfilesStorageBackend.open(dir);
    try {
      await backend.createProfile('alice', ['sessions']);
      await backend.createProfile('bob',   ['sessions']);

      await runAs({ id: 'alice', type: 'user' }, async () => {
        await backend.createStore('sessions').set('a1', { id: 'a1', version: 'v1' });
        await backend.createStore('skills').set('s1',   { id: 's1', version: 'v1' });
      });

      await runAs({ id: 'alice', type: 'user' }, async () => {
        assert.deepEqual(await backend.namespaces(), ['profile-registry', 'sessions', 'skills']);
      });
      await runAs({ id: 'bob', type: 'user' }, async () => {
        const found = await backend.namespaces();
        assert.ok(!found.includes('sessions'), "another profile's isolated namespace must not be listed");
        assert.ok(found.includes('skills'), 'a shared (base) namespace is still reachable');
      });
    } finally { await backend.close?.(); }
  });
});

// The decorator must not answer for a backend that cannot: absence is the signal a caller reads.
test('caching: `namespaces` is present only when the wrapped backend has it', async () => {
  const enumerable    = new CachingStorageBackend(await FilesystemStorageBackend.open('/nonexistent'));
  const nonEnumerable = new CachingStorageBackend({
    createStore: () => { throw new Error('unused'); },
    fileStore:   {} as never,
  });
  assert.equal(typeof enumerable.namespaces, 'function');
  assert.equal(nonEnumerable.namespaces, undefined, 'must not manufacture a capability the inner lacks');
});
