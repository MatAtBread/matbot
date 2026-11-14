import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotMachine } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { runOnce, factKey } from '../../../plugins/cognition/src/dream/runOnce.ts';
import type { Merger, Ranker } from '../../../plugins/cognition/src/dream/ranker.ts';
import type { DreamRun, RememberedFact } from '../../../plugins/cognition/src/dream/types.ts';

// A job every ten minutes whose prompt named three IP addresses had them remembered three hundred times a day.
// Each copy was ranked every 36 hours for ever, and merged — a whole-skill rewrite — whenever a re-roll scored
// it strong. A pass now retires a restatement of a fact already decided without ranking it, and ranks one copy
// of several identical new facts, which the rest follow.

const fact = (id: string, text: string, createdAt: string, dreamSkill?: string): RememberedFact => ({
  id, version: 'v', fact: text, sessionId: 's', messageId: 'm', createdAt, ...(dreamSkill !== undefined ? { dreamSkill } : {}),
});

test('factKey ignores case, spacing and trailing punctuation, and nothing else', () => {
  assert.equal(factKey('The bridge is at 192.168.0.20.'), factKey('the  bridge is at 192.168.0.20'));
  assert.notEqual(factKey('The bridge is at 192.168.0.20'), factKey('The bridge has IP address 192.168.0.20'));
  assert.notEqual(factKey('The offset is -5'), factKey('The offset is 5'));
});

test('a pass retires restatements unranked, and ranks one copy of several', async () => {
  const facts = new MemoryStore<RememberedFact>();
  for (const f of [
    fact('a1', 'The router is at 1.1.1.1.',  '2026-01-01T00:00:00Z', 'Net'),
    fact('a2', 'the router is at 1.1.1.1',   '2026-01-02T00:00:00Z'),
    fact('b1', 'Bridge is at 2.2.2.2',       '2026-01-03T00:00:00Z'),
    fact('b2', 'Bridge is at 2.2.2.2.',      '2026-01-04T00:00:00Z'),
    fact('b3', 'bridge is at 2.2.2.2',       '2026-01-05T00:00:00Z'),
    fact('c1', 'Weak fact',                  '2026-01-06T00:00:00Z'),
    fact('c2', 'Weak fact.',                 '2026-01-07T00:00:00Z'),
    fact('d1', 'Nothing fits',               '2026-01-08T00:00:00Z'),
    fact('d2', 'Nothing fits',               '2026-01-09T00:00:00Z'),
    fact('e1', 'Merge choked',               '2026-01-10T00:00:00Z', '__error__'),
    fact('e2', 'Merge choked',               '2026-01-11T00:00:00Z'),
  ]) await facts.set(f.id, f);

  const ranked: string[] = [];
  const ranker: Ranker = {
    async rank(fs, skills) {
      ranked.push(...fs.map(f => f.id));
      const score = (t: string) => (t.startsWith('Bridge') ? 0.9 : t.startsWith('Nothing') ? 0.1 : 0.6);
      return fs.flatMap(f => skills.map(s => ({ factId: f.id, skill: s.name, score: score(f.fact), reasoning: '' })));
    },
  };
  const merged: string[] = [];
  const merger: Merger = { async merge(_skill, content, f) { merged.push(f.id); return { content: `${content}\n${f.fact}`, contradictions: [] }; } };

  const services = {
    settings:     () => ({ get: async () => undefined }),
    createStore:  () => facts,
    SkillManager: {
      all:  async () => [{ name: 'Net', content: '# Net', knowledge: { summary: 'network', entities: [], tags: [] } }],
      get:  async () => ({ name: 'Net', content: '# Net' }),
      save: async () => {},
    },
  } as unknown as MatbotMachine;

  const pass = runOnce(services, ranker, merger, new AbortController().signal);
  let next = await pass.next();
  while (!next.done) next = await pass.next();
  const run: DreamRun = next.value;

  assert.deepEqual(ranked, ['b1', 'c1', 'd1', 'e2'], 'one copy of each new text, and a quarantined fact decided nothing');
  assert.deepEqual(merged, ['b1'], 'the strong fact is merged once, not once per copy');
  const skillOf = async (id: string) => (await facts.get(id))?.dreamSkill;
  assert.deepEqual(
    await Promise.all(['a2', 'b1', 'b2', 'b3', 'd1', 'd2'].map(skillOf)),
    ['__duplicate__', 'Net', '__duplicate__', '__duplicate__', '__none__', '__duplicate__'],
  );
  const c1 = await facts.get('c1');
  const c2 = await facts.get('c2');
  assert.ok(c1?.ignoreUntil !== undefined && c1.dreamSkill === undefined, 'a weak fact is deferred');
  assert.equal(c2?.ignoreUntil, c1.ignoreUntil, 'and its copy with it');
  assert.equal((await facts.get('e2'))?.ignoreUntil !== undefined, true);
  assert.deepEqual(
    { merged: run.mergedFactIds.length, deferred: run.deferred, retired: run.retired, duplicates: run.duplicates, remaining: run.unassignedRemaining },
    { merged: 1, deferred: 3, retired: 1, duplicates: 4, remaining: 0 },
  );
});

test('the ranker sends the roster as a prefix every call shares, and the fact alone as the message', async () => {
  const { createLlmRanker } = await import('../../../plugins/cognition/src/dream/llmRanker.ts');
  const calls: Array<{ system?: string; prompt: string }> = [];
  const services = {
    singleTurn: async (req: { system?: string; prompt: string }) => { calls.push(req); return { text: '{"scores":[]}' }; },
  } as unknown as MatbotMachine;
  const skills = [{ name: 'Net', summary: 'the house network', entities: [], tags: [] }];
  await createLlmRanker(services, 'p').rank(
    [fact('x', 'Bridge is at 2.2.2.2', ''), fact('y', 'Router is at 1.1.1.1', '')], skills, new AbortController().signal,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.system, calls[1]!.system, 'one shared system prompt');
  assert.match(calls[0]!.system ?? '', /the house network/);
  assert.doesNotMatch(calls[0]!.prompt, /the house network/);
  assert.match(calls[0]!.prompt, /Bridge is at 2\.2\.2\.2/);
});

test('a fact weak for the weakVerdictsBeforeBacklog-th time moves to the backlog, keeping its last verdict', async () => {
  const facts = new MemoryStore<RememberedFact>();
  for (const f of [
    { ...fact('w1', 'Weak once',       '2026-01-01T00:00:00Z') },
    { ...fact('w4', 'Weak fourth',     '2026-01-02T00:00:00Z'), weakVerdicts: 3 },
    { ...fact('w5', 'weak fourth.',    '2026-01-03T00:00:00Z') },
    { ...fact('n1', 'Nothing fits',    '2026-01-04T00:00:00Z') },
    { ...fact('x1', 'Weak fourth',     '2026-01-05T00:00:00Z') },
  ] as RememberedFact[]) await facts.set(f.id, f);

  const ranked: string[][] = [];
  const ranker: Ranker = {
    async rank(fs, skills) {
      ranked.push(fs.map(f => f.id));
      return fs.flatMap(f => skills.map(s => ({ factId: f.id, skill: s.name, score: f.fact.startsWith('Nothing') ? 0.1 : 0.6, reasoning: 'close' })));
    },
  };
  const merger: Merger = { async merge() { throw new Error('nothing is strong'); } };
  const services = {
    // No enrichment budget, so the `none` fact is deferred unanswered — which is not a weak verdict.
    settings:     () => ({ get: async () => ({ maxEnrichmentsPerPass: 0 }) }),
    createStore:  () => facts,
    SkillManager: {
      all: async () => [{ name: 'Net', content: '# Net', knowledge: { summary: 'network', entities: [], tags: [] } }],
      get: async () => ({ name: 'Net', content: '# Net' }), save: async () => {},
    },
  } as unknown as MatbotMachine;

  const drain = async (): Promise<DreamRun> => {
    const pass = runOnce(services, ranker, merger, new AbortController().signal);
    let next = await pass.next();
    while (!next.done) next = await pass.next();
    return next.value;
  };
  const run = await drain();

  const w1 = await facts.get('w1');
  assert.equal(w1?.weakVerdicts, 1);
  assert.ok(w1?.ignoreUntil !== undefined && w1.dreamSkill === undefined, 'a first weak verdict defers');
  assert.deepEqual(w1.lastVerdict, { skill: 'Net', score: 0.6, reasoning: 'close' });

  const w4 = await facts.get('w4');
  assert.equal(w4?.dreamSkill, '__backlog__');
  assert.equal(w4?.weakVerdicts, 4);
  assert.deepEqual(w4?.lastVerdict, { skill: 'Net', score: 0.6, reasoning: 'close' });
  assert.equal((await facts.get('w5'))?.dreamSkill, '__duplicate__', 'a copy follows its representative into the backlog as a duplicate');
  assert.equal((await facts.get('x1'))?.dreamSkill, '__duplicate__');

  const n1 = await facts.get('n1');
  assert.ok(n1?.ignoreUntil !== undefined && n1.weakVerdicts === undefined, 'an unanswered none fact is deferred uncounted');
  assert.deepEqual({ backlogged: run.backlogged, deferred: run.deferred, duplicates: run.duplicates }, { backlogged: 1, deferred: 2, duplicates: 2 });

  // A later copy of a backlogged text is a duplicate, never ranked.
  await facts.set('w6', fact('w6', 'Weak Fourth', '2026-02-01T00:00:00Z'));
  ranked.length = 0;
  await drain();
  assert.equal((await facts.get('w6'))?.dreamSkill, '__duplicate__');
  assert.deepEqual(ranked, []);
});

test('a weak fact whose anchors are all in the skill is retired as already known', async () => {
  const { alreadyStated, anchorsOf } = await import('../../../plugins/cognition/src/dream/runOnce.ts');
  assert.deepEqual(anchorsOf('The WAN router is at 192.168.0.1.'), ['192.168.0.1']);
  assert.deepEqual(anchorsOf('The check runs every 10 minutes'), [], 'small numbers are not anchors');
  assert.deepEqual(anchorsOf('Use `mosquitto_sub` on port 8088'), [], 'neither a quoted name nor a bare integer is an anchor');
  assert.deepEqual(anchorsOf('Pinned to session `312ee8de-0932-4a66-b611-23c799dcaab5`, skill ec626cb6'),
    ['312ee8de-0932-4a66-b611-23c799dcaab5', 'ec626cb6']);
  assert.deepEqual(anchorsOf('The cap applies from April 2027, at 12,000'), []);
  assert.deepEqual(anchorsOf('Fixed in 0.5.0 on 2026-11-14 at 19:49, not 1.5'), ['0.5.0', '2026-11-14', '19:49']);
  const skill = '| `192.168.0.1` | hub | WAN router |\nThe broker websocket is on 8088.';
  assert.ok(alreadyStated('The WAN router has IP address 192.168.0.1', skill));
  assert.ok(!alreadyStated('The printer is at 192.168.0.22', skill));
  assert.ok(!alreadyStated('The check runs every 10 minutes', skill), 'no anchors, never known');

  const facts = new MemoryStore<RememberedFact>();
  await facts.set('k1', fact('k1', 'The WAN router has IP address 192.168.0.1', '2026-01-01T00:00:00Z'));
  await facts.set('k2', fact('k2', 'The printer is at 192.168.0.22', '2026-01-02T00:00:00Z'));
  const ranker: Ranker = { async rank(fs, skills) { return fs.flatMap(f => skills.map(s => ({ factId: f.id, skill: s.name, score: 0.6, reasoning: '' }))); } };
  const merger: Merger = { async merge() { throw new Error('unused'); } };
  const services = {
    settings: () => ({ get: async () => undefined }),
    createStore: () => facts,
    SkillManager: {
      all: async () => [{ name: 'Net', content: skill, knowledge: { summary: 'network', entities: [], tags: [] } }],
      get: async () => ({ name: 'Net', content: skill }), save: async () => {},
    },
  } as unknown as MatbotMachine;
  const pass = runOnce(services, ranker, merger, new AbortController().signal);
  let next = await pass.next();
  while (!next.done) next = await pass.next();
  assert.equal((await facts.get('k1'))?.dreamSkill, '__known__');
  assert.equal((await facts.get('k2'))?.dreamSkill, undefined, 'a fact the skill lacks is deferred as before');
  assert.equal(next.value.known, 1);
});

test('a skill with no metadata yet is left out of the pass, not a reason to fail it', async () => {
  const facts = new MemoryStore<RememberedFact>();
  await facts.set('f', fact('f', 'Something', '2026-01-01T00:00:00Z'));
  const offered: string[][] = [];
  const ranker: Ranker = { async rank(fs, skills) { offered.push(skills.map(s => s.name)); return []; } };
  const services = {
    settings: () => ({ get: async () => ({ maxEnrichmentsPerPass: 0 }) }),
    createStore: () => facts,
    SkillManager: {
      all: async () => [
        { name: 'Net', content: '#', knowledge: { summary: 'network', entities: [], tags: [] } },
        { name: 'Fresh', content: '#' },
      ],
      get: async () => undefined, save: async () => {},
    },
  } as unknown as MatbotMachine;
  const warn = console.warn; console.warn = () => {};
  try {
    const pass = runOnce(services, ranker, { async merge() { throw new Error('unused'); } }, new AbortController().signal);
    let next = await pass.next();
    while (!next.done) next = await pass.next();
    assert.notEqual(next.value.outcome, 'error');
  } finally { console.warn = warn; }
  assert.deepEqual(offered, [['Net']]);
});
