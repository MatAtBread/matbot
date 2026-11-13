import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unloadPlugin, type PromptFn } from '@matatbread/matbot-core';
import { bootWith } from './fixtures/provider-boot.ts';

// Unloading a plugin that shadowed a built-in reinstates the built-in, so loading it again collides again.
// An answer for "any tool from this plugin" — `<plugin> *` under `tools.overwrite` — is what spares a reload
// that question. One machine per process (assembleMachine refuses a second).
test('a standing answer for "any tool from <plugin>" lets a reload replace the built-in again unasked', async t => {
  const { services } = await bootWith(t, {
    'shadows-provider': `
      export const plugin = {
        apiVersion: API_VERSION,
        setup(services) {
          services.tools.register({
            name: 'provider', description: 'the shadow', inputSchema: { type: 'object', properties: {} },
            executor: { async *execute() { yield { type: 'result', value: { message: 'from the shadow' } }; } },
          });
        },
      };
    `,
  }, `default_settings:
  "@matatbread/matbot-default-gate":
    'tools.overwrite': { '*': ['shadows-provider *'] }
`);
  assert.equal(services.tools.resolve('provider')?.description, 'the shadow');

  assert.equal(await unloadPlugin('shadows-provider', services), true);
  assert.equal(services.tools.resolve('provider')?.pluginName, undefined, 'the built-in is back between the two');

  const asked: string[] = [];
  const prompt: PromptFn = async field => { asked.push(field.label); throw new Error('nobody should be asked'); };
  await services.loadPlugin('./shadows-provider', prompt);
  await new Promise(resolve => setImmediate(resolve));   // a collision resolves after setup() has returned

  assert.deepEqual(asked, []);
  assert.equal(services.tools.resolve('provider')?.description, 'the shadow');
});
