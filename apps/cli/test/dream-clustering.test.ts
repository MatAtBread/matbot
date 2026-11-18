import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotMachine } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { runOnce } from '../../../plugins/cognition/src/dream/runOnce.ts';
import type { Clusterer, FactGroup, Merger, Ranker, SkillWriter } from '../../../plugins/cognition/src/dream/ranker.ts';
import type { DreamRun, RememberedFact } from '../../../plugins/cognition/src/dream/types.ts';

// The backlog holds facts no skill took after several rankings. A pass looks after it: facts filed in a skill
// that is gone come back to it, a skill added since the last pass gives every backlogged fact one more
// ranking, and once it has grown enough it is clustered — a group belonging to an existing skill merged into
// it in one call, a new group written up as a candidate skill.

const fact = (id: string, text: string, n: number, extra: Partial<RememberedFact> = {}): RememberedFact => ({
  id, version: 'v', fact: text, sessionId: 's', messageId: 'm',
  createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(), ...extra,
});

interface Skill { name: string; content: string; candidate?: boolean; knowledge?: { summary: string; entities: string[]; tags: string[] } }

function machine(facts: MemoryStore<RememberedFact>, skills: Skill[], settings: Record<string, unknown> = {}) {
  const saves: Array<{ name: string; candidate: boolean }> = [];
  const stored = new Map<string, unknown>(Object.entries(settings));
  const services = {
    settings:    () => ({ get: async (k: string) => stored.get(k), set: async (k: string, v: unknown) => { stored.set(k, v); } }),
    createStore: () => facts,
    SkillManager: {
      all:  async () => skills,
      get:  async (n: string) => skills.find(s => s.name.toLowerCase() === n.toLowerCase()),
      save: async (name: string, content: string, _c?: boolean, opts?: { candidate?: boolean }) => {
        saves.push({ name, candidate: opts?.candidate === true });
        const cur = skills.find(s => s.name === name);
        if (cur) cur.content = content; else skills.push({ name, content, ...(opts?.candidate ? { candidate: true } : {}) });
      },
    },
  } as unknown as MatbotMachine;
  return { services, saves, stored };
}

async function drain(gen: AsyncGenerator<unknown, DreamRun, void>): Promise<DreamRun> {
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

const net: Skill = { name: 'Net', content: '# Net', knowledge: { summary: 'network', entities: [], tags: [] } };
const noRank: Ranker = { async rank() { throw new Error('nothing should be ranked'); } };
const noMerge: Merger = { async merge() { throw new Error('nothing should be merged'); } };

test('a fact filed in a skill that is gone returns to the backlog, naming it', async () => {
  const facts = new MemoryStore<RememberedFact>();
  await facts.set('o', fact('o', 'Orphan', 0, { dreamSkill: 'Rejected Candidate' }));
  await facts.set('k', fact('k', 'Kept', 1, { dreamSkill: 'Net' }));
  const { services } = machine(facts, [{ ...net }], { 'dream-roster': ['net'] });
  const run = await drain(runOnce(services, noRank, noMerge, new AbortController().signal));
  assert.equal(run.orphaned, 1);
  const o = await facts.get('o');
  assert.equal(o?.dreamSkill, '__backlog__');
  assert.equal(o?.orphanedFrom, 'Rejected Candidate');
  assert.equal((await facts.get('k'))?.dreamSkill, 'Net');
});

test('with no skills listed at all, nothing is orphaned', async () => {
  const facts = new MemoryStore<RememberedFact>();
  await facts.set('k', fact('k', 'Kept', 0, { dreamSkill: 'Net' }));
  const { services } = machine(facts, []);
  await drain(runOnce(services, noRank, noMerge, new AbortController().signal));
  assert.equal((await facts.get('k'))?.dreamSkill, 'Net');
});

test('a skill added since the last pass gives each backlogged fact one more ranking, in that pass', async () => {
  const facts = new MemoryStore<RememberedFact>();
  await facts.set('b', fact('b', 'ISA cap is 20k', 0, { dreamSkill: '__backlog__', weakVerdicts: 4 }));
  const fin: Skill = { name: 'Finance', content: '# Finance', knowledge: { summary: 'money', entities: [], tags: [] } };
  const { services, stored } = machine(facts, [{ ...net }, fin], { 'dream-roster': ['net'] });
  const ranked: string[] = [];
  const ranker: Ranker = {
    async rank(fs, skills) {
      ranked.push(...fs.map(f => f.id));
      return fs.flatMap(f => skills.map(s => ({ factId: f.id, skill: s.name, score: s.name === 'Finance' ? 0.6 : 0.1, reasoning: '' })));
    },
  };
  const run = await drain(runOnce(services, ranker, noMerge, new AbortController().signal));
  assert.equal(run.released, 1);
  assert.deepEqual(ranked, ['b'], 'released and ranked in the same pass, not retired as a copy of itself');
  const b = await facts.get('b');
  assert.equal(b?.dreamSkill, '__backlog__', 'one weak answer sends it straight back');
  assert.equal(b?.weakVerdicts, 4);
  assert.deepEqual(stored.get('dream-roster'), ['finance', 'net']);

  ranked.length = 0;
  const again = await drain(runOnce(services, ranker, noMerge, new AbortController().signal));
  assert.equal(again.released, undefined, 'an unchanged roster releases nothing');
});

test('the first pass to see a roster records it and releases nothing', async () => {
  const facts = new MemoryStore<RememberedFact>();
  await facts.set('b', fact('b', 'x', 0, { dreamSkill: '__backlog__' }));
  const { services, stored } = machine(facts, [{ ...net }]);
  const run = await drain(runOnce(services, noRank, noMerge, new AbortController().signal));
  assert.equal(run.released, undefined);
  assert.deepEqual(stored.get('dream-roster'), ['net']);
});

test('a grown backlog is clustered: a homed group merged in one call, a new group made a candidate', async () => {
  const facts = new MemoryStore<RememberedFact>();
  const fin = Array.from({ length: 9 }, (_, i) => fact(`f${i}`, `Finance fact ${i}`, i, { dreamSkill: '__backlog__' }));
  const netFacts = [fact('n0', 'Router fact', 20, { dreamSkill: '__backlog__' }), fact('n1', 'Bridge fact', 21, { dreamSkill: '__backlog__' })];
  const small = [fact('s0', 'Sock habit', 30, { dreamSkill: '__backlog__' }), fact('s1', 'Fork habit', 31, { dreamSkill: '__backlog__', orphanedFrom: 'Eating Habits' })];
  for (const f of [...fin, ...netFacts, ...small]) await facts.set(f.id, f);
  const skills = [{ ...net }];
  const { services, saves, stored } = machine(facts, skills, { 'dream-roster': ['net'], 'dream-time': { clusterAfterBacklogGrowth: 10 } });

  let shown: { ids: string[]; rejected: readonly string[] } | undefined;
  const clusterer: Clusterer = {
    async cluster(fs, _skills, rejected) {
      shown = { ids: fs.map(f => f.id), rejected };
      const groups: FactGroup[] = [
        { name: 'Finance', scope: 'money', asked: 'How much is left in my ISA?', home: null, members: [...fin.map(f => f.id), 'nonsense'] },
        { name: 'Network', scope: 'lan', asked: '', home: 'Net', members: ['n0', 'n1', 'f0'] },      // f0 already taken
        { name: 'Habits', scope: 'habits', asked: 'What do I do with socks?', home: null, members: ['s0', 's1'] },  // too small
      ];
      return groups;
    },
  };
  const written: string[] = [];
  const writer: SkillWriter = { async write(g, fs) { written.push(`${g.name}:${fs.length}`); return `# ${g.name}`; } };
  const merges: string[][] = [];
  const merger: Merger = { async merge(_s, content, fs) { merges.push(fs.map(f => f.id)); return { content: content + '\n+', contradictions: [] }; } };

  const run = await drain(runOnce(services, noRank, merger, new AbortController().signal, { clusterer, writer }));
  assert.deepEqual(shown?.rejected, ['Eating Habits']);
  assert.equal(shown?.ids.length, 13);
  assert.deepEqual(written, ['Finance:9']);
  assert.deepEqual(saves, [{ name: 'Finance', candidate: true }, { name: 'Net', candidate: false }]);
  assert.deepEqual(merges, [['n0', 'n1']], 'one merge for the homed group, holding only facts no group took');
  assert.equal((await facts.get('f3'))?.dreamSkill, 'Finance');
  assert.equal((await facts.get('n1'))?.dreamSkill, 'Net');
  assert.equal((await facts.get('s0'))?.dreamSkill, '__backlog__', 'an undersized group stays in the backlog');
  assert.deepEqual(run.clustering, { backlog: 13, candidates: ['Finance'], mergedInto: ['Net'], filed: 11 });
  assert.equal((stored.get('dream-clustering') as { lastBacklog: number }).lastBacklog, 2);

  // Not again until the backlog grows by clusterAfterBacklogGrowth from what it left.
  const quiet = await drain(runOnce(services, noRank, merger, new AbortController().signal, { clusterer, writer }));
  assert.equal(quiet.clustering, undefined);
});

test('a new group no message would ask for, or with nothing a skill holds, is not made a skill; its facts stay', async () => {
  const facts = new MemoryStore<RememberedFact>();
  const pool = Array.from({ length: 18 }, (_, i) => fact(`p${i}`, `Provider fact ${i}`, i, { dreamSkill: '__backlog__' }));
  for (const f of pool) await facts.set(f.id, f);
  const { services, saves, stored } = machine(facts, [{ ...net }], { 'dream-roster': ['net'], 'dream-time': { clusterAfterBacklogGrowth: 10 } });
  const clusterer: Clusterer = {
    async cluster() {
      return [
        { name: 'Unasked', scope: 'x', asked: '', home: null, members: pool.slice(0, 9).map(f => f.id) },
        { name: 'Provider Configuration', scope: 'models', asked: 'Which model does the merger use?', home: null, members: pool.slice(9).map(f => f.id) },
      ];
    },
  };
  const asked: string[] = [];
  const writer: SkillWriter = { async write(g) { asked.push(g.name); return undefined; } };
  const run = await drain(runOnce(services, noRank, noMerge, new AbortController().signal, { clusterer, writer }));
  assert.deepEqual(asked, ['Provider Configuration'], 'a group with no message that would call for it is never written');
  assert.deepEqual(saves, []);
  assert.deepEqual(run.clustering, { backlog: 18, candidates: [], mergedInto: [], filed: 0, declined: ['Provider Configuration'] });
  for (const f of pool) assert.equal((await facts.get(f.id))?.dreamSkill, '__backlog__');
  assert.equal((stored.get('dream-clustering') as { lastBacklog: number }).lastBacklog, 18);
});

test('the LLM writer declines with NONE', async () => {
  const { createLlmSkillWriter } = await import('../../../plugins/cognition/src/dream/llmClusterer.ts');
  const services = { singleTurn: async () => ({ text: 'NONE' }) } as unknown as MatbotMachine;
  const out = await createLlmSkillWriter(services, 'p').write(
    { name: 'X', scope: '', asked: 'q', home: null, members: ['a'] }, [fact('a', 'x', 0)], new AbortController().signal);
  assert.equal(out, undefined);
});

test('a small backlog is not clustered', async () => {
  const facts = new MemoryStore<RememberedFact>();
  for (let i = 0; i < 5; i++) await facts.set(`b${i}`, fact(`b${i}`, `x${i}`, i, { dreamSkill: '__backlog__' }));
  const { services } = machine(facts, [{ ...net }], { 'dream-roster': ['net'] });
  const clusterer: Clusterer = { async cluster() { throw new Error('not expected'); } };
  const run = await drain(runOnce(services, noRank, noMerge, new AbortController().signal,
    { clusterer, writer: { async write() { return ''; } } }));
  assert.equal(run.clustering, undefined);
});

test('the LLM clusterer reads groups back by short handle, dropping handles it never showed', async () => {
  const { createLlmClusterer } = await import('../../../plugins/cognition/src/dream/llmClusterer.ts');
  let prompt = '';
  const services = {
    singleTurn: async (req: { prompt: string }) => {
      prompt = req.prompt;
      return { text: 'Thinking aloud.\n{"groups":[{"name":"Finance","scope":"money","asked":"What is my ISA cap?","home":null,"members":["f1","f3","f99"]},{"name":"Net","home":"Net","members":["f2"]}]}' };
    },
  } as unknown as MatbotMachine;
  const result = await createLlmClusterer(services, 'p').cluster(
    [fact('a', 'ISA cap', 0), fact('b', 'Router at 192.168.0.1', 1), fact('c', 'Pension', 2)],
    [{ name: 'Net', summary: 'network', entities: [], tags: [] }], ['Eating Habits'], new AbortController().signal,
  );
  assert.match(prompt, /f2: Router at 192\.168\.0\.1/);
  assert.match(prompt, /Rejected skills: Eating Habits/);
  assert.deepEqual(result, [
    { name: 'Finance', scope: 'money', asked: 'What is my ISA cap?', home: null, members: ['a', 'c'] },
    { name: 'Net', scope: '', asked: '', home: 'Net', members: ['b'] },
  ]);
});
