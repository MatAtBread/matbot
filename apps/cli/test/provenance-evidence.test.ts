import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUnits, deriveKeys, selectEvidence, excerpt, renderExtracts, wordRe,
} from '@matatbread/matbot-provenance/evidence';
import { CLASSIFIER_PROVIDER_KEY } from '@matatbread/matbot-provenance/keys';
import type { Session } from '@matatbread/matbot-plugin-api';

// Every bug this file guards against was the same one: a positional cap deciding, on the reader's
// behalf, that evidence sitting past character N does not exist. It happened at three layers in
// succession (per tool result, per unit, per excerpt), and each time the verdict was a confident
// "unsourced" for a claim the session stated outright.

function session(messages: Array<{ role: string; content: unknown[] }>): Session {
  return {
    id: 's1', version: 'v1', status: 'active', contexts: [], createdAt: '', updatedAt: '',
    messages: messages.map((m, i) => ({ id: `m${i}`, role: m.role, content: m.content, createdAt: '', traceId: 't' })),
  } as unknown as Session;
}

const toolResult = (id: string, name: string, result: unknown) => session([
  { role: 'assistant', content: [{ type: 'tool-call', id, name, input: {} }] },
  { role: 'tool',      content: [{ type: 'tool-result', id, result }] },
]);

test('a bullet list is items[] in prose, not one blob', () => {
  // Field case: a profile section was a single 2308-char bullet list, so the family member at char
  // 1093 was unreachable behind a 600-char head.
  const doc = [
    '- **Oldest son**: **Louis** (27). Journalist in Frankfurt.',
    '- **Middle son**: **Tom** (25). Speech and Language Therapist (SALT).',
    '- **Youngest**: **Alex** (21). Criminology graduate.',
  ].join('\n');
  const units = buildUnits(toolResult('c1', 'contextual_search', { name: 'Profile', content: doc }));
  assert.equal(units.length, 3);
  assert.match(units[1]!.text, /Tom.*SALT/);
  assert.equal(units[1]!.from, 'TOOL:contextual_search');
});

test('table rows carry their header, so a row of numbers can be read', () => {
  const rows = 'quarter,revenue_gbp,orders\nQ1,3100000,412\nQ2,3800000,455\nQ3,4200000,501\nQ4,4900000,588';
  const units = buildUnits(toolResult('c1', 'query_warehouse', { query: 'select *', rows: `${rows}\n${'x'.repeat(400)}` }));
  const q3 = units.find(u => u.text.includes('Q3'));
  assert.ok(q3, 'Q3 row missing');
  assert.match(q3.text, /^quarter,revenue_gbp,orders\n/);
});

test('every item of a large result is a unit — none of it is truncated away', () => {
  const items = Array.from({ length: 900 }, (_, i) => ({ fact: `fact number ${i}`, id: `f${i}` }));
  const units = buildUnits(toolResult('c1', 'remembered_facts_action', { items, total: 900 }));
  assert.equal(units.length, 900);
  assert.ok(units.some(u => u.text.includes('fact number 899')));
});

test('keys group their spellings, so a formatting difference is not an absence', () => {
  const groups = deriveKeys('Q3 revenue was 4,200,000');
  const numeric = groups.find(g => g[0] === '4,200,000');
  assert.deepEqual(numeric, ['4,200,000', '4200000']);
});

test('matching is whole-word: "Automation" is not "Tom"', () => {
  const re = wordRe('Tom');
  assert.equal(re.test('freehouse automation stack'), false);
  assert.equal(re.test('- **Middle son**: **tom** (25).'), true);
});

test('a caller-named key that appears nowhere zeroes the search', () => {
  // "Dermot is Matt's brother-in-law" must not select extracts on the strength of "Matt's" alone.
  const units = buildUnits(toolResult('c1', 'facts', { items: [{ fact: "Matt's wife is the French speaker" }] }));
  assert.deepEqual(selectEvidence(units, [['Dermot']], "Dermot is Matt's brother-in-law", true), []);
  assert.equal(selectEvidence(units, [['Matt']], "Matt's wife speaks French", true).length, 1);
});

test('without caller keys the veto is numbers-only, so vocabulary drift is not confabulation', () => {
  const units = buildUnits(toolResult('c1', 'q', { rows: `period,sales\nQ3,4200000\n${'x'.repeat(400)}` }));
  // "Revenue" is absent (the data says "sales") — a derived word must not veto.
  assert.ok(selectEvidence(units, deriveKeys('Q3 revenue was 4,200,000'), 'Q3 revenue was 4,200,000', false).length > 0);
  // A figure that appears nowhere in any spelling must.
  assert.deepEqual(selectEvidence(units, deriveKeys('Q3 revenue was 9,999,999'), 'Q3 revenue was 9,999,999', false), []);
});

test('ranking puts the claim-bearing unit first, ahead of same-name noise', () => {
  const units = buildUnits(toolResult('c1', 'facts', {
    items: [
      { fact: 'Tom Jones: rated green (positive).' },
      { fact: 'The next five artists are Bowie, Depeche Mode, Tom Waits.' },
      { fact: 'Tom — 25 years old. Speech and Language Therapist (SALT).' },
    ],
  }));
  const sel = selectEvidence(units, [['Tom'], ['SALT']], 'Tom is a Speech and Language Therapist (SALT)', true);
  assert.match(sel[0]!.text, /Speech and Language Therapist/);
});

test('an over-long unit is excerpted around the match, never from its head', () => {
  const text = `${'padding. '.repeat(120)}Tom is a Speech and Language Therapist.${' trailing.'.repeat(120)}`;
  assert.ok(text.indexOf('Tom is a Speech') > 600, 'fixture must place the match past a head window');
  const out = excerpt(text, [[wordRe('Tom')]], 600);
  assert.ok(out.includes('Tom is a Speech and Language Therapist.'), 'the match was cut away');
  assert.ok(out.length <= 606);
});

test('the prompt budget is spent best-first and extracts are numbered for citation', () => {
  const units = [
    { from: 'TOOL:a', text: 'x'.repeat(500) },
    { from: 'USER',   text: 'y'.repeat(500) },
    { from: 'TOOL:b', text: 'z'.repeat(500) },
  ];
  const rendered = renderExtracts(units, [[wordRe('x')]], 900);
  assert.match(rendered, /^\(0\) \[TOOL:a\]/);
  assert.ok(rendered.includes('(1) [USER]'));
  assert.ok(!rendered.includes('(2) [TOOL:b]'), 'budget was overspent');
});

test('markers are not evidence, and tool results are attributed to their tool', () => {
  const s = session([
    { role: 'user',      content: [{ type: 'text', text: 'my son Tom is a SALT' }] },
    { role: 'marker',    content: [{ type: 'marker', creator: 'triggers', data: { fact: 'Tom is a SALT' } }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'find_fact', input: {} }] },
    { role: 'tool',      content: [{ type: 'tool-result', id: 'c1', result: ['Tom is 25'] }] },
  ]);
  const units = buildUnits(s);
  assert.deepEqual(units.map(u => u.from), ['USER', 'TOOL:find_fact']);
});

// The plugin half: setup registers exactly one tool, under the name its contract is keyed by.
test('the plugin registers determine_provenance', async () => {
  const { plugin } = await import('@matatbread/matbot-provenance');
  const registered: Array<{ name: string; inputSchema: unknown }> = [];
  await plugin.setup!({
    tools: { register: (t: { name: string; inputSchema: unknown }) => registered.push(t) },
    settings: () => ({ get: async () => undefined }),
    providers: { has: () => false },
  } as never);
  assert.deepEqual(registered.map(t => t.name).sort(), ['determine_provenance', 'provenance_config']);
  const schema = registered.find(t => t.name === 'determine_provenance')!.inputSchema as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(schema.required, ['claims']);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['claims', 'probe', 'provider', 'sessionId']);
});

// The pin is written by one tool and read by another: a drifting key would silently mean "configured,
// and ignored", which reads as the classifier setting having no effect at all.
test('provenance_config writes the key determine_provenance reads', async () => {
  const { createProvenanceConfigTool } = await import('@matatbread/matbot-provenance/config');
  const store = new Map<string, unknown>();
  const tool = createProvenanceConfigTool({
    settings:  () => ({
      get:    async (k: string) => store.get(k),
      set:    async (k: string, v: unknown) => { store.set(k, v); },
      delete: async (k: string) => { store.delete(k); },
    }),
    providers: { has: (n: string) => n === 'fast-model', keys: () => ['fast-model', 'big-model'] },
  } as never);

  const run = async (input: unknown): Promise<unknown> => {
    let out: unknown;
    for await (const ev of tool.executor.execute(input, {} as never)) {
      if (ev.type === 'result') out = ev.value;
      if (ev.type === 'error')  out = { error: ev.message };
    }
    return out;
  };

  assert.deepEqual(await run({ action: 'get' }), { classifierProvider: null, available: ['fast-model', 'big-model'] });
  assert.deepEqual(await run({ action: 'set', provider: 'fast-model' }), { classifierProvider: 'fast-model' });
  assert.equal(store.get(CLASSIFIER_PROVIDER_KEY), 'fast-model');
  assert.deepEqual(await run({ action: 'get' }), { classifierProvider: 'fast-model', available: ['fast-model', 'big-model'] });
  // An unconfigured provider is refused rather than pinned to a name that will fail at call time.
  assert.match(String((await run({ action: 'set', provider: 'nope' }) as { error: string }).error), /Unknown provider/);
  assert.deepEqual(await run({ action: 'clear' }), { classifierProvider: null });
  assert.equal(store.has(CLASSIFIER_PROVIDER_KEY), false);
});
