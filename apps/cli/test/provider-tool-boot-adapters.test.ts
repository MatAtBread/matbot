import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootWith, FAKE_ADAPTER } from './fixtures/provider-boot.ts';

// The builtin is registered before any adapter loads, so its description is built when it is read.
test('without a shadow, the builtin `provider` lists the adapters loaded through `plugins:`', async t => {
  const { services } = await bootWith(t, { 'fake-adapter': FAKE_ADAPTER });

  const tool = services.tools.resolve('provider');
  assert.equal(tool?.pluginName, undefined);
  assert.match(tool?.description ?? '', /the fake adapter for the boot test/);
});
