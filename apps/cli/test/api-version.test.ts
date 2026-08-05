import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, PLUGIN_API_VERSION } from '@matatbread/matbot-core';
import type { MatbotMachine } from '@matatbread/matbot-core';

// PLUGIN_API_VERSION tracks the plugin-api package's major.minor. It sat at '0.1' through the whole of
// 0.3.x, so it conveyed nothing — and it is the one string every third-party plugin hardcodes, which
// makes a version boundary the only sane moment to correct it.
//
// The gate compares majors exactly and warns only on a *newer* declared minor, so at 0.x the correction
// is a no-op for anything already in the wild. This test pins that: the fixtures below declare '0.1'
// literally (not via the const), and must still load against a runtime advertising 0.4.
const legacyFixture = new URL('./fixtures/valid-plugin.ts', import.meta.url).href;

const noopServices = {
  resolver:   undefined,
  tools:      { register() {}, remove() {}, resolve: () => null, list: () => [], removeByPlugin() {} },
  Notifier:   { notify() {}, subscribe: () => (async function* () {})(), consume() {} },
  createStore: () => ({ get: async () => null, set: async () => {}, cas: async () => ({ ok: true }), delete: async () => {} }),
  mounted:    { observe() {} },
  hooks:      { register() {}, removeByPlugin() {} },
  systemContext: { register() {}, removeByPlugin() {}, build: async () => '' },
  register:   async () => {},
  unregister: () => {},
  registerFrontend: () => {},
  get: () => undefined,
} as unknown as MatbotMachine;

test('PLUGIN_API_VERSION is a major.minor pair', () => {
  assert.match(PLUGIN_API_VERSION, /^\d+\.\d+$/);
});

test('a plugin declaring an older minor of the same major still loads', async () => {
  const [major] = PLUGIN_API_VERSION.split('.');
  assert.equal(major, '0', 'this fixture declares 0.1; revisit it when the major moves');

  const loaded = await loadPlugins([{ spec: legacyFixture, importSpec: legacyFixture }], noopServices, false, undefined, 'skip');
  assert.equal(loaded.length, 1, "a hardcoded '0.1' must not become a load failure");
  assert.equal(loaded[0]?.apiVersion, '0.1');
});
