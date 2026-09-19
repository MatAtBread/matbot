import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleMachine, ProviderRegistryImpl, installPrincipalCarrier, createConstantPrincipalCarrier, quiesced,
} from '@matatbread/matbot-core';
import type { Vault, FileStore, KnowledgeIndex } from '@matatbread/matbot-core';
import { defaultGate } from '@matatbread/matbot-default-gate';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';

// Both hosts now stand their machine up through `assembleMachine`, so what used to be two hand-kept
// copies of the boot graph is asserted once, here: the storage swap waits for the edge and reverts to
// the host's own backend, seeded and swap-member services revert rather than vanish, and the core tools
// arrive with the machine.

installPrincipalCarrier(createConstantPrincipalCarrier({ id: 'tester', type: 'user' }));

const vault = (secrets: Record<string, string>): Vault => ({
  resolve: async (ref: string) => ref.replace(/\$\{(\w+)\}/g, (_, k: string) => secrets[k] ?? ''),
} as unknown as Vault);

async function machine(t: { after(fn: () => Promise<void>): void }, extra: { resolveSecret?: (ref: string, v: Vault) => Promise<string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-assemble-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const boot = new FilesystemStorageBackend(join(dir, 'boot'));
  const other = new FilesystemStorageBackend(join(dir, 'other'));
  const assembled = assembleMachine({
    bootBackend: boot,
    vault:       vault({ KEY: 'secret-value' }),
    providers:   new ProviderRegistryImpl(new Map()),
    gate:        defaultGate,
    version:     '9.9.9',
    ...extra,
    host: () => ({
      loadPlugin:   async () => { throw new Error('unused'); },
      unloadPlugin: async () => false,
      isSubAgent:   () => false,
      TypeScriptStripper: { strip: (s: string) => s },
    }),
  });
  return { ...assembled, boot, other };
}

test('a StorageBackend swap lands at the edge, and unregistering reverts to the boot backend', async t => {
  const { services, boot, other } = await machine(t);
  const store = services.createStore<{ id: string; version: string; v: string }>('things');
  await store.set('a', { id: 'a', version: '1', v: 'on boot' });

  await services.register('StorageBackend', other);
  await quiesced();
  assert.equal(await store.get('a'), null, 'a captured store follows the swap to the new backend');
  assert.ok(await boot.createStore('things').get('a'), 'and nothing was migrated off the old one');

  services.unregister('StorageBackend');
  await quiesced();
  assert.equal((await store.get('a'))?.v, 'on boot', 'back on the host\'s own backend');
});

test('a seeded service reverts on unregister rather than disappearing', async t => {
  const { services } = await machine(t);
  const hostFiles = services.MediaStore;
  assert.ok(hostFiles, 'the host file area is the media store out of the box');

  await services.register('MediaStore', {} as FileStore);
  assert.notEqual(services.MediaStore, hostFiles);
  services.unregister('MediaStore');
  assert.equal(services.MediaStore, hostFiles);
});

test('a swap-member is capture-safe and reverts to its boot impl', async t => {
  const { services } = await machine(t);
  const captured = services.KnowledgeIndex;
  const marker = [{ id: 'from the replacement' }];
  const replacement = { search: async () => marker, index: async () => {} } as unknown as KnowledgeIndex;

  await services.register('KnowledgeIndex', replacement);
  assert.equal(await captured.search([{ term: 'x' }], new AbortController().signal), marker, 'the captured reference follows the swap');
  services.unregister('KnowledgeIndex');
  assert.notEqual(await captured.search([{ term: 'x' }], new AbortController().signal), marker, 'and follows the revert');
});

test('the core tools arrive with the machine', async t => {
  const { services } = await machine(t);
  const names = services.tools.list().map(tool => tool.name);
  for (const name of ['gate_action', 'single_turn', 'about_matbot']) assert.ok(names.includes(name), name);
  assert.ok(services.run, 'with a session runner over the sessions store');
});

test('a provider\'s secrets resolve through the host\'s resolver when it supplies one', async t => {
  const seen: string[] = [];
  const { services } = await machine(t, { resolveSecret: async ref => { seen.push(ref); return 'asked'; } });
  services.providers.register({ name: 'p', module: 'no-such-adapter', model: 'm', credentials: { apiKey: '${KEY}' } });
  await assert.rejects(services.complete({ provider: 'p', messages: [] }), /no loadable adapter/);
  assert.deepEqual(seen, ['${KEY}']);
});
