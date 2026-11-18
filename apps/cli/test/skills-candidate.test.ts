import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LookupKnowledgeIndex } from '@matatbread/matbot-core';
import type { MatbotMachine } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { SkillManagerImpl } from '../../../plugins/skills/src/manager.ts';
import type { SkillDoc } from '../../../plugins/skills/src/index.ts';

// A candidate skill is one dream-time proposed from facts that had no home. It is withheld from the model as
// a hidden skill is — out of the knowledge index — but unlike a hidden skill it is analysed, because
// dream-time ranks facts against the metadata cached on it. Adopting it puts it in the index.

function harness() {
  const knowledge = new LookupKnowledgeIndex();
  const store = new MemoryStore<SkillDoc>();
  const services = {
    KnowledgeIndex: knowledge,
    providers:      new Map([['p', { name: 'p', module: 'fake', model: 'fake' }]]),
    settings:       () => ({ get: async () => undefined }),
    singleTurn:     async () => ({ text: '{"summary":"money matters","entities":["ISA"],"tags":["finance"],"classification":{"procedural":0.1,"informational":0.9}}' }),
    Notifier:       { notify() {} },
  } as unknown as MatbotMachine;
  return { knowledge, store, manager: new SkillManagerImpl(store, services) };
}

const indexed = (k: LookupKnowledgeIndex) => [...k.entries()].map(e => e.id);
async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !until(); i++) await new Promise(r => setTimeout(r, 5));
}

test('a candidate is analysed but not indexed, and adopting it indexes it', async () => {
  const { knowledge, store, manager } = harness();
  const doc = await manager.save('Finance', '# Finance\nISA limits.', undefined, { candidate: true });
  for (let i = 0; i < 100 && (await store.get(doc.id))?.knowledge === undefined; i++) await new Promise(r => setTimeout(r, 5));

  const stored = await store.get(doc.id);
  assert.equal(stored?.candidate, true);
  assert.equal(stored?.knowledge?.summary, 'money matters', 'its metadata is cached for dream-time to rank against');
  assert.deepEqual(indexed(knowledge), [], 'but the model cannot find it');
  assert.deepEqual((await manager.list()).map(s => [s.name, s.candidate]), [['Finance', true]]);

  await manager.setCandidate('Finance', false);
  await settle(() => indexed(knowledge).length > 0);
  assert.deepEqual(indexed(knowledge), [doc.id]);
  assert.equal((await store.get(doc.id))?.candidate, undefined, 'adopted, the flag is gone rather than false');
});

test('candidate is set only on the save that creates a skill', async () => {
  const { manager } = harness();
  await manager.save('Plain', '# Plain');
  await manager.save('Plain', '# Plain, edited', undefined, { candidate: true });
  assert.equal((await manager.get('Plain'))?.candidate, undefined);
});
