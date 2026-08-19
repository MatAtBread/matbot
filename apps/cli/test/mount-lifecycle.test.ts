import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, unloadPlugin, createMountTable, unifyServices, RegistryChangeKind } from '@matatbread/matbot-core';
import type { MatbotMachine, MountTable, Notification } from '@matatbread/matbot-core';
import { calls } from './fixtures/mount-observer.ts';

// A mount interest's only cleanup path is an aborted signal, and `signal` is optional — so a plugin
// that omitted it left a live interest behind on unload, whose handler kept firing into a torn-down
// closure (and accumulated one live handler per reload generation, since reload = unload + load).
// The host now binds every plugin-scoped observe() to that plugin's load extent, so ownership is the
// host's to know rather than the author's to remember.
const observer = new URL('./fixtures/mount-observer.ts', import.meta.url).href;

function machineWithMountTable(): {
  services: MatbotMachine; table: MountTable; published: Notification[]; setBackend(v: object | undefined): void;
} {
  let services: MatbotMachine;
  // Present to start with, so a flush is a mount/remount unless a test takes it away.
  let backend: object | undefined = {};
  const published: Notification[] = [];
  const table = createMountTable(() => services);
  services = unifyServices({
    get StorageBackend() { return backend; },
    mounted:      table.mounted,
    resolver:     undefined,
    tools:        { register() {}, remove() {}, resolve: () => null, list: () => [], removeByPlugin() {} },
    Notifier:     { notify(n: Notification) { published.push(n); }, subscribe: () => (async function* () {})(), consume() {} },
    createStore:  () => ({ get: async () => null, set: async () => {}, cas: async () => ({ ok: true }), delete: async () => {} }),
    hooks:        { register() {}, removeByPlugin() {} },
    systemContext:{ register() {}, removeByPlugin() {}, build: async () => '' },
    register:     async () => {},
    unregister:   () => {},
    registerFrontend: () => {},
    get: () => undefined,
  } as unknown as MatbotMachine);
  return { services, table, published, setBackend(v) { backend = v; } };
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


// A `StorageBackend` swap writes nothing, so `notifyingStore` — which only sees writes made through it —
// says nothing, and every document in every namespace silently starts coming from somewhere else. The
// mount table reaches in-process subscribers only; a browser listing sessions, skills and files learns
// about the swap from the bus or not at all.
test('a service transition is published on the bus, whether or not anything in-process subscribes', async () => {
  const { table, published, setBackend } = machineWithMountTable();

  table.markDirty('StorageBackend');
  table.flush();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(published.map(n => [n.kind, (n as { registry: string }).registry, (n as { name: string }).name, (n as { operation: string }).operation]),
    [[RegistryChangeKind, 'services', 'StorageBackend', 'added']]);

  setBackend(undefined);
  table.markDirty('StorageBackend');
  table.flush();
  await new Promise(r => setImmediate(r));
  assert.equal((published.at(-1) as { operation: string }).operation, 'removed');

  // Dirtied but never present: the key had nothing before and has nothing now, so there is no fact.
  published.length = 0;
  table.markDirty('KnowledgeIndex');
  table.flush();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(published, []);
});

// The handlers are how the caches a remote reader queries THROUGH get rebuilt (a SkillManager's
// documents, function-tools' compiled set), so announcing before they settle invites the browser to
// re-query the displaced backend's contents — the very staleness the announcement exists to end.
test('the announcement waits for the mount handlers to settle', async () => {
  const { services, table, published } = machineWithMountTable();
  let released!: () => void;
  const rebuilt = new Promise<void>(r => { released = r; });

  services.mounted.observe({ key: 'StorageBackend' }, () => rebuilt);

  table.markDirty('StorageBackend');
  table.flush();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(published, [], 'nothing is announced while a handler is still rebuilding');

  released();
  await new Promise(r => setImmediate(r));
  assert.equal(published.length, 1, 'the announcement lands once the handler has settled');
});
