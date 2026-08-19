import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPrincipalCarrier, runAs, isReadOnlyError } from '@matatbread/matbot-core';
import { ProfilesStorageBackend } from '@matatbread/matbot-storage-profiles';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';

// The base partition's id is the empty string (`BASE = ''`) — an internal routing sentinel, and the right
// one: it is the path segment that isn't there. `readOnlyError` renders it (`owner || 'global'`), so the
// exception a refused write raises names the sharer. The `share` tool's `owner` action did not, in either
// form, so an LLM asking "who owns this?" got `{ owner: "" }` — falsy, and sitting in a contract whose
// `null` already means "you own it". The two readings are opposite and the wrong one is the plausible one.
//
// This also pins the shape `compact-sessions-readonly.test.ts` stubs: that a refused session write on a
// REAL backend is a branded ReadOnlyError carrying `owner: ''`, and not something else.
installPrincipalCarrier(createAlsPrincipalCarrier());

type Doc = { id: string; version: string };

// A session written outside any profile and shared into one — the field case. Sessions predate the profile
// (or arrive from a frontend with no profile in force), so the base owns them and the profile reads them.
async function withBaseShare(fn: (b: ProfilesStorageBackend) => Promise<void>): Promise<void> {
  const dir     = await mkdtemp(join(tmpdir(), 'matbot-shared-owner-'));
  const backend = await ProfilesStorageBackend.open(dir);
  try {
    await backend.createProfile('Matt', ['sessions']);
    await runAs({ id: 'nobody', type: 'user' }, async () => {
      const base = backend.createStore<Doc>('sessions');
      await base.set('s1', { id: 's1', version: '1' });
      await backend.share('sessions', 's1', 'Matt');       // source partition is BASE: unprofiled principal
    });
    await fn(backend);
  } finally {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('a write to a session shared in from base is refused as a branded ReadOnlyError naming the base', async () => {
  await withBaseShare(async backend => {
    await runAs({ id: 'Matt', type: 'user' }, async () => {
      const store = backend.createStore<Doc>('sessions');
      const doc   = await store.get('s1');
      assert.ok(doc, 'the share is readable — that is the point of it');

      const e = await store.cas('s1', doc.version, { ...doc, version: '2' }).then(() => undefined, (x: unknown) => x);
      assert.ok(isReadOnlyError(e), `a refused write must be the branded error, not a bare Error: ${String(e)}`);
      assert.equal(e.namespace, 'sessions');
      assert.equal(e.id, 's1');
      assert.equal(e.owner, '', 'the base partition IS the empty id — the sentinel is intended');
      assert.match(e.message, /shared by "global"/, 'and the message renders it rather than showing ""');
    });
  });
});

test('the owner action never hands back the bare sentinel, in either form', async () => {
  await withBaseShare(async backend => {
    await runAs({ id: 'Matt', type: 'user' }, async () => {
      assert.equal(await backend.ownerOf('sessions', 's1').then(p => p?.id), '',
        'the backend surface keeps the routing sentinel — this is the boundary that renders it');

      const single = await ownerAction(backend, { namespace: 'sessions', id: 's1' });
      assert.equal((single as { owner: string | null }).owner, 'global',
        'a shared-in item must not report an owner that reads as absent');

      const bulk = await ownerAction(backend, { namespace: 'sessions', id: '*' });
      assert.deepEqual((bulk as { owners: Record<string, string> }).owners, { s1: 'global' });
    });
  });
});

test('an item the caller owns still reports null, distinctly from a base owner', async () => {
  await withBaseShare(async backend => {
    await runAs({ id: 'Matt', type: 'user' }, async () => {
      await backend.createStore<Doc>('sessions').set('mine', { id: 'mine', version: '1' });
      const res = await ownerAction(backend, { namespace: 'sessions', id: 'mine' });
      assert.equal((res as { owner: string | null }).owner, null, '`null` means "yours" and must stay unambiguous');
    });
  });
});

// Drive the real `share` tool: the rendering under test is its presentation of the backend's answer.
async function ownerAction(backend: ProfilesStorageBackend, args: { namespace: string; id: string }): Promise<unknown> {
  const { createShareTool } = await import('../../../plugins/storage/profiles/src/tool.ts');
  const tool = createShareTool(() => backend, () => undefined);
  for await (const ev of tool.executor.execute({ action: 'owner', ...args }, {} as never)) {
    if (ev.type === 'result') return ev.value;
    if (ev.type === 'error')  throw new Error(ev.message);
  }
  throw new Error('the owner action yielded no result');
}
