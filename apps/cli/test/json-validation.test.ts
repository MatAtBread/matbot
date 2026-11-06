import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plugin } from '../../../plugins/json-validation/src/index.ts';
import type { JSONSchema, Hook, ToolInputError } from '@matatbread/matbot-plugin-api';

type Validate = Extract<Hook, { on: 'validate' }>;

async function validatorFor(inputSchema: JSONSchema): Promise<{ validateToolCall(tool: string, parameters: unknown): Promise<ToolInputError[] | undefined> }> {
  let registered: Validate | undefined;
  const services = {
    tools: { resolve: () => ({ inputSchema }) },
    hooks: { register: (h: Hook) => { if (h.on === 'validate') registered = h; } },
  };
  await plugin.setup!(services as never);
  assert.ok(registered);
  const hook = registered;
  return {
    validateToolCall: async (tool, parameters) =>
      (await hook.handler({ tool, parameters, signal: new AbortController().signal, removeHook() {} })) ?? undefined,
  };
}

test('an undeclared key is named first when the call is refused anyway', async () => {
  // `background`'s schema: no `action`, no `additionalProperties`. Sent `every_action`'s call shape, the
  // only error used to be `.prompt` missing — which sends the caller to its arguments, not the tool.
  const v = await validatorFor({ type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } });
  const errs = await v.validateToolCall('background', { action: 'cancel', id: 'x' });
  assert.deepEqual(errs?.map(e => `${e.path}: ${e.message}`),
    ['.action: unexpected property', '.id: unexpected property', '.prompt: required property missing']);

  // The schema admits undeclared keys, so on a call it otherwise accepts they are still no refusal.
  assert.deepEqual(await v.validateToolCall('background', { prompt: 'p', extra: 1 }), []);
});
