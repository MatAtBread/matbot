import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugins } from '@matatbread/matbot-core';
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

test('interactive mode (throw) surfaces the not-a-plugin error', async () => {
  await assert.rejects(
    loadPlugins(
      [{ spec: notAPlugin, importSpec: notAPlugin }],
      stubServices,
      /* bustCache */ false,
      /* prompt */ undefined,
      'throw',
    ),
    /not a matbot plugin/,
  );
});
