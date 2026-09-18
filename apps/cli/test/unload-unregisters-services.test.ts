import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, unloadPlugin, unifyServices } from '@matatbread/matbot-core';
import type { MatbotMachine } from '@matatbread/matbot-core';
import { state } from './fixtures/registers-service.ts';

// A plugin's `teardown` closes what it built; it does NOT unregister what it registered. That division
// is only safe if the loader unregisters for it, and unregisters BEFORE awaiting teardown — otherwise a
// consumer resolves a service whose backing resource has just been closed, and every call through it
// throws. With a validator on the executor that failure mode reaches every tool at once, so this pins
// the ordering rather than trusting it.
const fixture = new URL('./fixtures/registers-service.ts', import.meta.url).href;

function machine(): { services: MatbotMachine; registry: Record<string, unknown> } {
  const registry: Record<string, unknown> = {};
  let services: MatbotMachine;
  services = unifyServices({
    get ToolTypeIndex() { return registry['ToolTypeIndex']; },
    mounted:      { observe: () => () => {}, consume: () => () => {} },
    resolver:     undefined,
    tools:        { register() {}, remove() {}, resolve: () => null, list: () => [], removeByPlugin() {} },
    Notifier:     { notify() {}, subscribe: () => (async function* () {})(), consume() {} },
    createStore:  () => ({ get: async () => null, set: async () => {}, cas: async () => ({ ok: true }), delete: async () => {} }),
    hooks:        { register() {}, removeByPlugin() {} },
    systemContext:{ register() {}, removeByPlugin() {}, build: async () => '', parts: async () => [] },
    register:     async (k: string, v: unknown) => { registry[k] = v; },
    unregister:   (k: string) => { delete registry[k]; },
    registerFrontend: () => {},
    get: (k: string) => registry[k],
  } as unknown as MatbotMachine);
  return { services, registry };
}

test('unloading a plugin unregisters the services it registered', async () => {
  const { services, registry } = machine();

  const loaded = await loadPlugins([{ spec: fixture, importSpec: fixture }], services, false, undefined, 'skip');
  assert.equal(loaded.length, 1, 'the fixture should load');
  assert.ok(registry['ToolTypeIndex'], 'setup registers the service');

  await unloadPlugin('registers-service', services);

  // The point: the plugin never unregistered anything, and the key is gone anyway. A consumer that
  // duck-types on `services.ToolTypeIndex` therefore sees ABSENCE (which it can handle) rather than a
  // closed object that looks present and throws on use.
  assert.equal(registry['ToolTypeIndex'], undefined, 'the loader must unregister the plugin\'s keys');
  assert.equal(state.closed, true, 'and teardown must still have run');
});

// teardown() races a 10s timeout. The loser of that race used to be left running: a successful unload
// returned with a live timer, which holds the event loop open for the rest of its 10s — so `plugin
// unload` followed by exit sat there waiting for nothing. Invisible except as a hang.
test('unloading a plugin leaves no pending teardown timer behind', async () => {
  const { services } = machine();
  const timers = (): number => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;

  await loadPlugins([{ spec: fixture, importSpec: fixture }], services, false, undefined, 'skip');
  const before = timers();
  await unloadPlugin('registers-service', services);

  assert.equal(timers(), before, 'the teardown timeout must be cleared however the race settles');
});
