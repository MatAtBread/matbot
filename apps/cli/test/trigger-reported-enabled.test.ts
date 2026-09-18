import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTriggerActionTool } from '../../../plugins/triggers/src/tools.ts';
import type { Trigger } from '../../../plugins/triggers/src/types.ts';
import type { MatbotMachine, ToolContext, ToolEvent } from '../../../plugin-api/src/index.ts';

// `enabled` is stored only when it was explicitly written, so a listing carried it for some triggers and
// omitted it for others — and "absent ⇒ enabled" is a rule a reader had to know rather than see. Two
// triggers that behave identically read differently, and one of them reads as though it might be off.

const base = { conditions: [], invoke: { tool: 't' }, createdAt: '', updatedAt: '' };
const STORED: Trigger[] = [
  { id: 'never-written', version: '1', ...base },                    // absent ⇒ enabled
  { id: 'explicit-true', version: '1', enabled: true,  ...base },
  { id: 'explicit-false', version: '1', enabled: false, ...base },
];

const manager = {
  all:   async () => STORED,
  query: async () => STORED,
  get:   async (id: string) => STORED.find(t => t.id === id),
} as unknown as Parameters<typeof createTriggerActionTool>[0];

const tool = createTriggerActionTool(manager, {} as unknown as MatbotMachine);

async function run(input: unknown): Promise<unknown> {
  const events: ToolEvent<unknown>[] = [];
  for await (const ev of tool.executor.execute(input, {} as unknown as ToolContext)) events.push(ev);
  const result = events.find(e => e.type === 'result');
  assert.ok(result && result.type === 'result', `expected a result, got ${JSON.stringify(events)}`);
  return result.value;
}

test('every listed trigger carries enabled, including one stored without it', async () => {
  const { triggers } = await run({ action: 'list' }) as { triggers: Array<{ id: string; enabled: boolean }> };
  assert.deepEqual(triggers.map(t => [t.id, t.enabled]), [
    ['never-written',  true],
    ['explicit-true',  true],
    ['explicit-false', false],
  ]);
  assert.ok(triggers.every(t => 'enabled' in t), 'the field is present on every row, never omitted');
});

test('get resolves it the same way', async () => {
  assert.equal((await run({ action: 'get', id: 'never-written' })  as { enabled: boolean }).enabled, true);
  assert.equal((await run({ action: 'get', id: 'explicit-false' }) as { enabled: boolean }).enabled, false);
});

test('query resolves it too — the same rows reached through a filter', async () => {
  const { triggers } = await run({ action: 'query' }) as { triggers: Array<{ enabled: boolean }> };
  assert.ok(triggers.every(t => typeof t.enabled === 'boolean'));
});
