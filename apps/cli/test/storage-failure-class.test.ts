import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { failureOf } from '@matatbread/matbot-core';
import { SQLiteStorageBackend } from '../../../plugins/storage/sqlite/src/backend.ts';

// A store says whether its failure is worth trying again, because only it can tell: another connection
// holding the database clears when it lets go; a malformed write never will.

test('sqlite: a database another connection holds fails as unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-sqlite-busy-'));
  const backend = await SQLiteStorageBackend.open(dir);
  const other = new DatabaseSync(join(dir, 'matbot.db'));
  try {
    const store = backend.createStore<{ id: string; version: string }>('things');
    await store.set('a', { id: 'a', version: '1' });

    other.exec('BEGIN IMMEDIATE');   // another process mid-write
    const e = await store.cas('a', '1', { id: 'a', version: '2' }).then(() => undefined, (err: unknown) => err);
    assert.ok(e instanceof Error, 'the write could not proceed');
    assert.match(e.message, /locked/);
    assert.equal(failureOf(e), 'unavailable');

    other.exec('ROLLBACK');
    assert.deepEqual(await store.cas('a', '1', { id: 'a', version: '2' }), { ok: true, doc: { id: 'a', version: '2' } }, 'and later it does');
  } finally {
    other.close();
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});
