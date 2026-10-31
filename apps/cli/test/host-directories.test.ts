import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatbotMachine, StorageBackend } from '@matatbread/matbot-core';
import { nodePluginMembers } from '@matatbread/matbot-host-node';
import { plugin as filesystemStorage } from '../../../plugins/storage/filesystem/src/index.ts';

// A plugin is handed the host's directories and derives none: there is no config file to find `.data`
// beside, and no working directory to assume.

async function activate(machine: Partial<MatbotMachine>): Promise<StorageBackend | undefined> {
  let registered: StorageBackend | undefined;
  await filesystemStorage.setup!({
    ...machine,
    register: async (key: string, value: unknown) => { if (key === 'StorageBackend') registered = value as StorageBackend; },
  } as unknown as MatbotMachine);
  return registered;
}

test('a storage plugin activated at run time keeps its files in the dataDir the host gives', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-datadir-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'state');

  const backend = await activate({ dataDir });
  assert.ok(backend, 'it registered a backend');
  await backend.createStore<{ id: string; version: string }>('notes').set('n1', { id: 'n1', version: 'v1' });

  assert.deepEqual(await readdir(dir), ['state'], 'nothing written beside it');
  assert.deepEqual(await readdir(dataDir), ['notes']);
});

test('with no dataDir there is nowhere to keep files, so it registers nothing', async () => {
  assert.equal(await activate({}), undefined);
});

test("nodePluginMembers reports the directory it resolves plugins from as the host's projectDir", () => {
  const members = nodePluginMembers(() => ({}) as MatbotMachine, '/srv/app');
  assert.equal(members.projectDir, '/srv/app');
});
