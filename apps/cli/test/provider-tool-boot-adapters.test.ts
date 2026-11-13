import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootWith } from './fixtures/provider-boot.ts';

// The builtin's description lists the loaded adapters, so it is built again once they have loaded.
test('without a shadow, the builtin `provider` lists the adapters loaded through `plugins:`', async () => {
  const { services } = await bootWith('fake-adapter', `
    export const plugin = {
      apiVersion: API_VERSION,
      manifest: { description: 'the fake adapter for the boot test' },
      provider: () => ({ name: 'fake', async health() { return { ok: true }; }, async *complete() {} }),
    };
  `);

  const tool = services.tools.resolve('provider');
  assert.equal(tool?.pluginName, undefined);
  assert.match(tool?.description ?? '', /the fake adapter for the boot test/);
});
