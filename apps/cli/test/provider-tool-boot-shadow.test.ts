import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootWith } from './fixtures/provider-boot.ts';

// Shadows `provider` as a storage plugin does (maxie-user-providers; storage-google-drive's browser one):
// capture what is registered at setup() — the builtin, to delegate to — and register its own.
test('a plugin that shadows `provider` captures the builtin and keeps its name through boot', async () => {
  const { services } = await bootWith('shadows-provider', `
    export const plugin = {
      apiVersion: API_VERSION,
      setup(services) {
        const captured = services.tools.resolve('provider');
        globalThis.shadowSawBuiltin = captured !== null && captured.pluginName === undefined;
        services.tools.register({
          name: 'provider', description: 'the shadow', inputSchema: { type: 'object', properties: {} },
          executor: { async *execute() { yield { type: 'result', value: { message: 'from the shadow' } }; } },
        });
      },
    };
  `);

  assert.equal((globalThis as { shadowSawBuiltin?: boolean }).shadowSawBuiltin, true,
    'the builtin `provider` must be in the registry when a plugin sets up');
  assert.equal(services.tools.resolve('provider')?.description, 'the shadow',
    'boot must not register the builtin over a plugin\'s shadow');
});
