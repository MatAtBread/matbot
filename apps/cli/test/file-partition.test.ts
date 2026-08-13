import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPrincipalCarrier, runAs } from '@matatbread/matbot-core';
import { ProfilesStorageBackend } from '@matatbread/matbot-storage-profiles';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';

// `url_for_resource` used to mint the `~<id>` segment of a file URL from the identity in force, gated on
// nothing but "the profiles plugin is loaded". A principal with no profile writes to the shared base area,
// so that stamped an addressable partition onto a file that was never in one — and a principal can hold
// several profiles, or alias its files onto another profile's area, so the identity does not name the area
// its writes land in at all. The address now comes from the router that placed the bytes.
installPrincipalCarrier(createAlsPrincipalCarrier());

async function withBackend(fn: (b: ProfilesStorageBackend) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-file-partition-'));
  const backend = await ProfilesStorageBackend.open(dir);
  try { await fn(backend); }
  finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
}

const bytes = (s: string) => (async function* () { yield new TextEncoder().encode(s); })();

test('a principal with no profile writes to the base area, which has no address', async () => {
  await withBackend(async backend => {
    await runAs({ id: 'matt', type: 'user' }, async () => {
      await backend.fileStore.put('report.md', 'text/markdown', bytes('hi'), { namespace: 'workspace' });
      assert.equal(backend.filePartition(), undefined, 'an unprofiled principal must not acquire a partition token');
    });
  });
});

test('a profile that does not isolate files is likewise base', async () => {
  await withBackend(async backend => {
    await backend.createProfile('Matt', ['sessions']);
    await runAs({ id: 'Matt', type: 'user' }, async () => {
      assert.equal(backend.filePartition(), undefined, 'isolating sessions must not address the file area');
    });
  });
});

test('a profile that isolates files gets a token that reads its own bytes back', async () => {
  await withBackend(async backend => {
    await backend.createProfile('Louis', ['files']);
    // Same name in both areas: a token that resolved to the wrong one would still find *a* file, so the
    // round trip is only proved by the contents.
    await runAs({ id: 'matt', type: 'user' }, () =>
      backend.fileStore.put('report.md', 'text/markdown', bytes('base'), { namespace: 'workspace' }));

    const token = await runAs({ id: 'Louis', type: 'user' }, async () => {
      await backend.fileStore.put('report.md', 'text/markdown', bytes('louis'), { namespace: 'workspace' });
      return backend.filePartition();
    });
    assert.equal(token, 'Louis');

    // No principal scope at all — a browser GET replaying the URL, which is the whole point of the token.
    const read = async () => {
      const handle = await backend.fileStore.getByName('report.md', 'workspace');
      assert.ok(handle, 'the addressed file should exist');
      let text = '';
      for await (const chunk of handle.stream()) text += new TextDecoder().decode(chunk);
      return text;
    };
    assert.equal(await backend.enterFilePartition(token!, read), 'louis');
    assert.equal(await read(), 'base', 'outside the pin, the base area is unchanged');
  });
});

test('the pin covers the file area only, leaving documents routed by principal', async () => {
  await withBackend(async backend => {
    await backend.createProfile('Louis', ['files', 'sessions']);
    const sessions = backend.createStore<{ id: string; version: string }>('sessions');
    await runAs({ id: 'Louis', type: 'user' }, () => sessions.set('s1', { id: 's1', version: '1' }));

    await backend.enterFilePartition('Louis', async () => {
      assert.equal(await sessions.get('s1'), null, 'a files pin must not drag the document stores with it');
    });
  });
});
