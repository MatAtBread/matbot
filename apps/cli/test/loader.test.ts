import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, isNotAPluginError, getFailedPlugins, recordFailedPlugin } from '@matatbread/matbot-core';
import type { MatbotMachine } from '@matatbread/matbot-core';

// Regression guard for the boot crash-loop: a non-plugin entry in matbot.yaml (a bare library
// mistaken for a plugin) once threw out of the startup batch, exiting the process — which, under
// systemd Restart=always, is an unbreakable loop fixable only by hand-editing the config. The
// startup batch must skip such an entry; only an explicit, user-initiated load may throw.
const notAPlugin = new URL('./fixtures/not-a-plugin.ts', import.meta.url).href;

// loadPlugins fails this entry at shape verification, before any service is touched, so a bare stub
// (no resolver) is enough to reach the branch under test.
const stubServices = { resolver: undefined } as unknown as MatbotMachine;

test('startup mode (skip) logs and skips a non-plugin module rather than aborting', async () => {
  const loaded = await loadPlugins(
    [{ spec: notAPlugin, importSpec: notAPlugin }],
    stubServices,
    /* bustCache */ false,
    /* prompt */ undefined,
    'skip',
  );
  assert.deepEqual(loaded, []);
});

// The throw is a *typed* NotAPluginError, not a bare Error — that is the signal the `plugin add` flow
// keys on to roll the specifier back out of matbot.yaml (a permanent "this is a library" fault),
// distinct from a transient setup() failure left in config to retry.
test('interactive mode (throw) surfaces a typed NotAPluginError', async () => {
  await assert.rejects(
    loadPlugins(
      [{ spec: notAPlugin, importSpec: notAPlugin }],
      stubServices,
      /* bustCache */ false,
      /* prompt */ undefined,
      'throw',
    ),
    (e: unknown) => isNotAPluginError(e) && e.specifier === notAPlugin && /not a matbot plugin/.test(e.message),
  );
});

// Graceful failure must not be *silent*: a skipped load is recorded so the `plugin` tool + web UI can
// show it. A light services stub — the store is only touched lazily by settings, and rollback errors
// are caught by the loader, so no-op members suffice for setup() to run and, if it throws, roll back.
const validPlugin  = new URL('./fixtures/valid-plugin.ts', import.meta.url).href;
const throwsInSetup = new URL('./fixtures/throws-in-setup.ts', import.meta.url).href;
const noopServices = {
  resolver:   undefined,
  tools:      { register() {}, remove() {}, resolve: () => null, list: () => [], removeByPlugin() {}, watch: () => (async function* () {})() },
  createStore: () => ({ get: async () => null, set: async () => {}, cas: async () => ({ ok: true }), delete: async () => {} }),
  mounted:    { consume() {} },
  hooks:      { register() {}, removeByPlugin() {} },
  systemContext: { register() {}, removeByPlugin() {}, build: async () => '' },
  register:   async () => {},
  unregister: () => {},
  registerFrontend: () => {},
  get: () => undefined,
} as unknown as MatbotMachine;

test('skip mode records the load failure so it can be surfaced (not swallowed)', async () => {
  await loadPlugins([{ spec: notAPlugin, importSpec: notAPlugin }], stubServices, false, undefined, 'skip');
  const failed = getFailedPlugins().find(f => f.specifier === notAPlugin);
  assert.ok(failed, 'the skipped non-plugin should be recorded');
  assert.match(failed.error, /not a matbot plugin/);
});

test('a setup() throw is rolled back and recorded in skip mode', async () => {
  const loaded = await loadPlugins([{ spec: throwsInSetup, importSpec: throwsInSetup }], noopServices, false, undefined, 'skip');
  assert.deepEqual(loaded, []);
  const failed = getFailedPlugins().find(f => f.specifier === throwsInSetup);
  assert.ok(failed, 'the plugin that threw in setup() should be recorded');
  assert.match(failed.error, /boom in setup/);
  assert.equal(failed.name, 'throws-in-setup');
});

test('a successful load clears a prior recorded failure for the same specifier', async () => {
  recordFailedPlugin({ specifier: validPlugin, error: 'stale failure from a previous boot' });
  assert.ok(getFailedPlugins().some(f => f.specifier === validPlugin));

  const loaded = await loadPlugins([{ spec: validPlugin, importSpec: validPlugin }], noopServices, false, undefined, 'skip');
  assert.equal(loaded.length, 1);
  assert.equal(getFailedPlugins().some(f => f.specifier === validPlugin), false, 'a successful load must clear the stale failure');
});
