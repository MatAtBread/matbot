import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, unloadPlugin, createMountTable, unifyServices } from '@matatbread/matbot-core';
import type { MatbotMachine, MountTable } from '@matatbread/matbot-core';
import { calls } from './fixtures/mount-observer.ts';

// A mount interest's only cleanup path is an aborted signal, and `signal` is optional — so a plugin
// that omitted it left a live interest behind on unload, whose handler kept firing into a torn-down
// closure (and accumulated one live handler per reload generation, since reload = unload + load).
// The host now binds every plugin-scoped observe() to that plugin's load extent, so ownership is the
// host's to know rather than the author's to remember.
const observer = new URL('./fixtures/mount-observer.ts', import.meta.url).href;

function machineWithMountTable(): { services: MatbotMachine; table: MountTable } {
  let services: MatbotMachine;
  const table = createMountTable(() => services);
  services = unifyServices({
    // Present, so every flush below is a mount/remount rather than an unload.
    StorageBackend: {},
    mounted:      table.mounted,
    resolver:     undefined,
    tools:        { register() {}, remove() {}, resolve: () => null, list: () => [], removeByPlugin() {} },
    Notifier:     { notify() {}, subscribe: () => (async function* () {})(), consume() {} },
    createStore:  () => ({ get: async () => null, set: async () => {}, cas: async () => ({ ok: true }), delete: async () => {} }),
    hooks:        { register() {}, removeByPlugin() {} },
    systemContext:{ register() {}, removeByPlugin() {}, build: async () => '' },
    register:     async () => {},
    unregister:   () => {},
    registerFrontend: () => {},
    get: () => undefined,
  } as unknown as MatbotMachine);
  return { services, table };
}

test('a plugin unload drops its mount interests even when it passed no signal', async () => {
  const { services, table } = machineWithMountTable();
  calls.count = 0;

  const loaded = await loadPlugins([{ spec: observer, importSpec: observer }], services, false, undefined, 'skip');
  assert.equal(loaded.length, 1, 'the observer fixture should load');

  table.markDirty('StorageBackend');
  table.flush();
  assert.equal(calls.count, 1, 'a live plugin observes the mount');

  await unloadPlugin('mount-observer', services);

  table.markDirty('StorageBackend');
  table.flush();
  assert.equal(calls.count, 1, 'the unloaded plugin must not observe a later mount');
});

// Reload is unload + load, so the generation that accumulated before was silent: `run()` catches and
// logs a handler throw, leaving N stale handlers doing duplicate work rather than failing loudly.
test('reloading a signal-less observer leaves exactly one live interest', async () => {
  const { services, table } = machineWithMountTable();
  calls.count = 0;

  for (let i = 0; i < 3; i++) {
    await loadPlugins([{ spec: observer, importSpec: observer }], services, false, undefined, 'skip');
    await unloadPlugin('mount-observer', services);
  }
  await loadPlugins([{ spec: observer, importSpec: observer }], services, false, undefined, 'skip');

  table.markDirty('StorageBackend');
  table.flush();
  assert.equal(calls.count, 1, 'only the current generation should be subscribed');
});
