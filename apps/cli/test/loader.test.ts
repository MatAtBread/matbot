import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins, NotAPluginError } from '@matatbread/matbot-core';
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
    (e: unknown) => e instanceof NotAPluginError && e.specifier === notAPlugin && /not a matbot plugin/.test(e.message),
  );
});
