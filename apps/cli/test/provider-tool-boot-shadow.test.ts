import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unloadPlugin, type Tool } from '@matatbread/matbot-core';
import { bootWith, FAKE_ADAPTER } from './fixtures/provider-boot.ts';

type Seen = { shadowCaptured?: Tool | null };

// Shadows `provider` as a storage plugin does (maxie-user-providers; storage-google-drive's browser one):
// capture what is registered at setup() — the builtin, to delegate to — and register its own. Listed
// BEFORE the adapter, so what it captured was built while no adapter was loaded.
test('a plugin that shadows `provider` captures a live builtin, keeps its name, and gives it back on unload', async t => {
  const { services } = await bootWith(t, {
    'shadows-provider': `
      export const plugin = {
        apiVersion: API_VERSION,
        setup(services) {
          globalThis.shadowCaptured = services.tools.resolve('provider');
          services.tools.register({
            name: 'provider', description: 'the shadow', inputSchema: { type: 'object', properties: {} },
            executor: { async *execute() { yield { type: 'result', value: { message: 'from the shadow' } }; } },
          });
        },
      };
    `,
    'fake-adapter': FAKE_ADAPTER,
  });

  const captured = (globalThis as Seen).shadowCaptured;
  assert.ok(captured, 'the builtin `provider` must be in the registry when a plugin sets up');
  assert.equal(captured.pluginName, undefined);
  assert.match(captured.description, /the fake adapter for the boot test/,
    'what a shadow captured describes the adapters loaded since, not those loaded when it captured it');
  assert.equal(services.tools.resolve('provider')?.description, 'the shadow',
    'boot must not register the builtin over a plugin\'s shadow');

  assert.equal(await unloadPlugin('shadows-provider', services), true);
  const back = services.tools.resolve('provider');
  assert.equal(back?.pluginName, undefined, 'unloading the shadow reinstates the builtin it displaced');
  assert.match(back?.description ?? '', /the fake adapter for the boot test/);
});
