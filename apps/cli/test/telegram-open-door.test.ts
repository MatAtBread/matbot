import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionDecision, PermissionRequest, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { permitted, refused } from '@matatbread/matbot-core';
import { plugin } from '../../../plugins/frontend/telegram/src/plugin.ts';

// Whoever comes through the door gets the owner's access, so opening it is the user's decision (#111).

async function open(decide: (req: PermissionRequest) => PermissionDecision): Promise<{ events: ToolEvent[]; asked: PermissionRequest[] }> {
  const door = plugin.tools?.find(t => t.name === 'telegram_open_door');
  assert.ok(door);
  const asked: PermissionRequest[] = [];
  const ctx = { gate: async (req: PermissionRequest) => { asked.push(req); return decide(req); } } as unknown as ToolContext;
  const events: ToolEvent[] = [];
  for await (const ev of door.executor.execute({}, ctx)) events.push(ev);
  return { events, asked };
}

test('opening the door asks, and refuses with nobody to ask', async () => {
  const no = await open(() => refused('fallback'));
  assert.equal(no.events[0]?.type, 'error');
  assert.deepEqual(no.asked.map(r => [r.gate, r.subject, r.fallback]), [['open', 'join', false]]);

  const yes = await open(() => permitted('user'));
  assert.equal(yes.events[0]?.type, 'result');
});
