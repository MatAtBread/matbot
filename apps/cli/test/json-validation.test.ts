import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plugin } from '../../../plugins/json-validation/src/index.ts';
import type { ToolInputValidator } from '@matatbread/matbot-core';
import type { JSONSchema } from '@matatbread/matbot-plugin-api';

async function validatorFor(inputSchema: JSONSchema): Promise<ToolInputValidator> {
  let registered: ToolInputValidator | undefined;
  const services = {
    tools: { resolve: () => ({ inputSchema }) },
    register: async (_key: string, v: ToolInputValidator) => { registered = v; },
  };
  await plugin.setup(services as never);
  assert.ok(registered);
  return registered;
}

test('an undeclared key is named first when the call is refused anyway', async () => {
  // `background`'s schema: no `action`, no `additionalProperties`. Sent `every_action`'s call shape, the
  // only error used to be `.prompt` missing — which sends the caller to its arguments, not the tool.
  const v = await validatorFor({ type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } });
  const errs = await v.validateToolCall('background', { action: 'cancel', id: 'x' });
  assert.deepEqual(errs?.map(e => `${e.path}: ${e.message}`),
    ['.action: not a declared property', '.id: not a declared property', '.prompt: required property missing']);

  // The schema admits undeclared keys, so on a call it otherwise accepts they are still no refusal.
  assert.deepEqual(await v.validateToolCall('background', { prompt: 'p', extra: 1 }), []);
});
