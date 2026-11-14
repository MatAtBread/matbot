import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatbotMachine, StorageBackend, Tool, ToolTypeIndex } from '@matatbread/matbot-core';
import { createToolTypesPlugin } from '@matatbread/matbot-tool-types';
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

test('with no projectDir the type check resolves from its own install, not the working directory', { timeout: 60000 }, async t => {
  const empty = await mkdtemp(join(tmpdir(), 'matbot-cwd-'));
  const cwd = process.cwd();
  process.chdir(empty);
  t.after(async () => { process.chdir(cwd); await rm(empty, { recursive: true, force: true }); });

  const probe: Tool = {
    name: 'probe', description: 'a probe', inputSchema: { type: 'object' },
    toolContract: 'ToolContract<{ n: number }, { a: string }>',
    executor: { execute: () => (async function* () {})() },
  };
  let index: ToolTypeIndex | undefined;
  await createToolTypesPlugin().setup!({
    Notifier: { consume: () => {}, notify: () => {} },
    mounted: { observe() {} },
    tools: { list: () => [probe], resolve: (n: string) => n === 'probe' ? probe : null, register() {}, remove() {}, removeByPlugin() {} },
    register: async (k: string, v: unknown) => { if (k === 'ToolTypeIndex') index = v as ToolTypeIndex; },
  } as unknown as MatbotMachine);
  assert.ok(index);

  // Unresolved, plugin-api's types are `any` and both of these would pass.
  const good = await index.check(`const r = await tool.probe({ a: 'x' }); const n: number = r.n;`);
  assert.equal(good.ok, true, JSON.stringify(good));
  const bad = await index.check(`const r = await tool.probe({ a: 1 }); const s: string = r.n;`);
  assert.equal(bad.ok, false, 'a wrong argument and a wrong result type are both caught');
});
