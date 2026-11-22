import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, installPrincipalCarrier, runAs } from '@matatbread/matbot-core';
import type { MatbotMachine, Tool, ToolContext } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { createAlsPrincipalCarrier } from '@matatbread/matbot-host-node';
import { createBackgroundJobsPlugin, filterJobTriggers } from '../../../plugins/background-jobs/src/index.ts';
import type { Trigger, TriggerFilter } from '../../../plugins/triggers/src/index.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());

// A job's prompt is its turn's user message, and is the same text at every run: a job every ten minutes whose
// prompt named three IP addresses had them remembered three hundred times a day. `triggers` on the job says
// which parts of its own turn the triggers judge; these pin how it is set and how it composes.

const PRINCIPAL = { id: 'tester', type: 'user' as const };
const ctx = { session: { id: 's', messages: [] }, signal: new AbortController().signal, provider: 'p' } as unknown as ToolContext;

async function call(tool: Tool, input: unknown): Promise<Array<{ type: string; value?: unknown; message?: string }>> {
  const events: Array<{ type: string; value?: unknown; message?: string }> = [];
  await runAs(PRINCIPAL, async () => { for await (const ev of tool.executor.execute(input, ctx)) events.push(ev as never); });
  return events;
}

test('triggers is stored on a job, changed by update, and an unknown value is refused', async () => {
  const store = new MemoryStore<{ id: string; version: string; triggers?: string }>();
  const tools = new Map<string, Tool>();
  const plugin = createBackgroundJobsPlugin({ description: 'test', runner: () => ({ run: async () => ({ appended: 0, reply: '' }) }) });
  await plugin.setup!({
    isSubAgent:  () => false,
    createStore: (ns: string) => (ns === 'jobs' ? store : new MemoryStore()),
    tools:       { register: () => {} },
  } as unknown as MatbotMachine);
  for (const t of plugin.tools ?? []) tools.set(t.name, t as Tool);
  try {
    const job    = tools.get('background_job')!;
    const action = tools.get('background_job_action')!;

    const made = await call(job, { prompt: 'p', interval: '10m', triggers: 'reply' });
    const id   = (made[0]!.value as { id: string }).id;
    assert.equal((await store.get(id))?.triggers, 'reply');

    assert.deepEqual((await call(action, { action: 'update', id, triggers: 'none' }))[0], { type: 'result', value: { updated: true, id, triggers: 'none' } });
    assert.equal((await store.get(id))?.triggers, 'none');

    assert.match((await call(action, { action: 'update', id, triggers: 'some' }))[0]!.message ?? '', /Invalid "triggers"/);
    assert.match((await call(job, { prompt: 'p', interval: '10m', triggers: 'prompt' }))[0]!.message ?? '', /Invalid "triggers"/);
    assert.match((await call(action, { action: 'update', id: 'nope', triggers: 'all' }))[0]!.message ?? '', /not found/);
    assert.equal((await store.get(id))?.triggers, 'none', 'a refused update changes nothing');
  } finally {
    await plugin.teardown?.();
  }
});

test('the job filter narrows the one it displaces, and is never wider than it', async () => {
  const a = { id: 'a' } as Trigger;
  const b = { id: 'b' } as Trigger;
  const services: Record<string, unknown> = {};
  const machine = { register: async (k: string, v: unknown) => { services[k] = v; } } as unknown as MatbotMachine;
  const displaced: TriggerFilter = { admit: triggers => triggers.filter(t => t.id !== 'b') };
  services['TriggerFilter'] = displaced;
  Object.defineProperty(machine, 'TriggerFilter', { get: () => services['TriggerFilter'] });

  const job = createSession({ title: 'job' });
  const chat = createSession({ title: 'chat' });
  await filterJobTriggers(machine, s => (s.id === job.id ? 'reply' : undefined));
  const filter = services['TriggerFilter'] as TriggerFilter;
  assert.notEqual(filter, displaced);

  const ids = async (session: typeof job, surface: 'user' | 'agent') => (await filter.admit([a, b], { session, surface })).map(t => t.id);
  assert.deepEqual(await ids(job, 'user'),   [],    'a reply-only job\'s prompt is not judged');
  assert.deepEqual(await ids(job, 'agent'),  ['a'], 'its reply is, as far as the displaced filter allows');
  assert.deepEqual(await ids(chat, 'user'),  ['a'], 'and any other session is the displaced filter\'s alone');
});
