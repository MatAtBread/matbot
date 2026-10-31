import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleMachine, ProviderRegistryImpl, installPrincipalCarrier, createConstantPrincipalCarrier, installUsageCarrier,
  loadPlugins, unloadPlugin, quiesced,
} from '@matatbread/matbot-core';
import type { Vault, MatbotMachine, StorageBackend } from '@matatbread/matbot-core';
import { createAlsUsageCarrier } from '@matatbread/matbot-host-node';
import { defaultGate } from '@matatbread/matbot-core';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';
import type { Layer } from './fixtures/stacks-service.ts';

// The registry holds one value per key, and plugins can stack on a key by registering over one another
// (a policy gate over a gate). Unloading used to `unregister` the key outright, whichever plugin was
// current: unloading the one UNDERNEATH removed the one on top, and unloading the one on top reverted
// past the one it had displaced. (json-validation under ts-validation did exactly this, before both
// became `validate` hooks.)

installPrincipalCarrier(createConstantPrincipalCarrier({ id: 'tester', type: 'user' }));
installUsageCarrier(createAlsUsageCarrier());

let seq = 0;
async function machine(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-layers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { services } = assembleMachine({
    bootBackend: new FilesystemStorageBackend(join(dir, 'boot')),
    vault:       { resolve: async (r: string) => r } as unknown as Vault,
    providers:   new ProviderRegistryImpl(new Map()),
    gate:        defaultGate,
    version:     '0',
    host: () => ({
      loadPlugin:   async () => { throw new Error('unused'); },
      unloadPlugin: async () => false,
      isSubAgent:   () => false,
      TypeScriptStripper: { strip: (s: string) => s },
    }),
  });
  return { services, dir };
}

async function stack(services: MatbotMachine, key: string, ...names: string[]): Promise<string[]> {
  const run = ++seq;
  const reqs = names.map(as => {
    const url = new URL(`./fixtures/stacks-service.ts?as=${as}&key=${key}&run=${run}`, import.meta.url).href;
    return { spec: url, importSpec: url, name: `stacks-${as}-${run}` };
  });
  const loaded = await loadPlugins(reqs, services, false, undefined, 'skip');
  assert.equal(loaded.length, names.length);
  return loaded.map(p => p.name);
}

const current = (services: MatbotMachine, key = 'ExampleService'): Layer | undefined =>
  (services as unknown as Record<string, Layer | undefined>)[key];

test('unloading the displaced plugin leaves the one on top in place', async t => {
  const { services } = await machine(t);
  const [a, b] = await stack(services, 'ExampleService', 'a', 'b');
  assert.equal(current(services)?.as, 'b');

  await unloadPlugin(a!, services);
  assert.equal(current(services)?.as, 'b', 'unloading the plugin underneath must not remove the current one');

  await unloadPlugin(b!, services);
  assert.equal(current(services), undefined, 'the last one out reverts to the host');
});

test('unloading the plugin on top reinstates the one it displaced', async t => {
  const { services } = await machine(t);
  const [a, b] = await stack(services, 'ExampleService', 'a', 'b');

  await unloadPlugin(b!, services);
  assert.equal(current(services)?.as, 'a', 'the displaced registration is current again');

  await unloadPlugin(a!, services);
  assert.equal(current(services), undefined);
});

test('a swap-member reinstates the displaced plugin, not the host default', async t => {
  const { services } = await machine(t);
  const boot = services.PermissionGate;
  const [a, b] = await stack(services, 'PermissionGate', 'a', 'b');

  await unloadPlugin(b!, services);
  assert.equal((services.PermissionGate as unknown as Layer).as, 'a');

  await unloadPlugin(a!, services);
  assert.equal(services.PermissionGate, boot, 'and only the last one out reverts to the host\'s boot gate');
});

// A displaced backend is closed by the swap, so it cannot be reinstated — but unloading it must not
// pull the live one out from under everything either, which `unregister` did (it staged the boot backend).
test('unloading a displaced storage plugin leaves the live backend alone', async t => {
  const { services, dir } = await machine(t);
  const first  = new FilesystemStorageBackend(join(dir, 'first'));
  const second = new FilesystemStorageBackend(join(dir, 'second'));
  const run = ++seq;
  const spec = (as: string, backend: StorageBackend) => {
    (globalThis as Record<string, unknown>)[`__backend_${as}_${run}`] = backend;
    return `data:text/javascript,export const plugin = { apiVersion: '0.1', async setup(s) { await s.register('StorageBackend', globalThis['__backend_${as}_${run}']); } };`;
  };
  const loaded = await loadPlugins([
    { spec: spec('first', first), name: `store-first-${run}` },
    { spec: spec('second', second), name: `store-second-${run}` },
  ], services, false, undefined, 'skip');
  assert.equal(loaded.length, 2);
  const store = services.createStore<{ id: string; version: string; v: string }>('things');
  await quiesced();
  await second.createStore('things').set('x', { id: 'x', version: '1', v: 'second' });
  assert.equal((await store.get('x'))?.v, 'second');

  await unloadPlugin(`store-first-${run}`, services);
  await quiesced();
  assert.equal((await store.get('x'))?.v, 'second', 'the live backend is still the second one');

  await unloadPlugin(`store-second-${run}`, services);
  await quiesced();
  assert.equal(await store.get('x'), null, 'withdrawing the live one reverts to the boot backend');
});
