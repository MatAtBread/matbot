import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMountTable, unifyServices, LookupKnowledgeIndex } from '@matatbread/matbot-core';
import type { MatbotMachine, KnowledgeIndex } from '@matatbread/matbot-core';
import { setupSkills } from '../../../plugins/skills/src/index.ts';
import type { SkillDoc } from '../../../plugins/skills/src/index.ts';

// The host drains a displaced KnowledgeIndex only through `entries()`, which persist-ki-bge does not
// have — so swapping it out, or unloading it (revert to the boot default), left search empty until the
// next restart (#75). The index is a projection of the skills store, so the SkillManager rebuilds it.
test('skills are re-indexed into a KnowledgeIndex that replaces the active one', async () => {
  let services: MatbotMachine;
  const table = createMountTable(() => services);
  let knowledge: KnowledgeIndex = new LookupKnowledgeIndex();
  const registry = new Map<string, unknown>();
  const skill: SkillDoc = {
    id: 'volvo', version: '1', name: 'volvo', content: '# Volvo\nThe user drives a blue Volvo.',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as SkillDoc;

  services = unifyServices({
    get KnowledgeIndex() { return knowledge; },
    StorageBackend: {},
    mounted:       table.mounted,
    providers:     new Map(),
    settings:      () => ({ get: async () => undefined }),
    createStore:   () => ({ get: async () => skill, query: async () => ({ items: [skill] }), cas: async () => ({ ok: true }) }),
    tools:         { register() {} },
    systemContext: { register() {} },
    register:      async (k: string, v: unknown) => { registry.set(k, v); },
    get:           (k: string) => registry.get(k),
    Notifier:      { notify() {} },
  } as unknown as MatbotMachine);

  await setupSkills(services);
  await new Promise(r => setImmediate(r));

  const next = new LookupKnowledgeIndex();
  knowledge = next;
  table.markDirty('KnowledgeIndex');
  table.flush();
  // The reindex is detached (it may analyse with an LLM), so wait for it rather than for a fixed tick.
  for (let i = 0; i < 100 && [...next.entries()].length === 0; i++) await new Promise(r => setTimeout(r, 10));

  assert.deepEqual([...next.entries()].map(e => e.id), ['volvo']);
});
