import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildMatbotToolsDts, checkSnippetAgainst } from '@matatbread/matbot-tool-types';

// Graded against the dts the generator emits, in both directions: if the ambient types failed to resolve,
// everything would be `any` and the bad snippets would pass as well.
const root = join(import.meta.dirname, '..', '..', '..');
let prefix = '';
let built: NonNullable<Awaited<ReturnType<typeof buildMatbotToolsDts>>>;

before(async () => {
  const dts = await buildMatbotToolsDts(root);
  assert.ok(dts);
  built = dts;
  prefix = `${dts.dts}\ndeclare const tool: import('@matatbread/matbot-plugin-api').ToolProxy;\n`;
}, { timeout: 120000 });

async function check(snippet: string): Promise<string[]> {
  const report = await checkSnippetAgainst({
    root,
    source:      `${prefix}${snippet}\nexport {};\n`,
    prefixLen:   prefix.length,
    prefixLines: prefix.split('\n').length - 1,
    apiIndexPath: join(root, 'plugin-api', 'src', 'index.ts'),
  });
  return report.diagnostics.map(d => d.rendered);
}

const call = (body: string): string => `async function f() { ${body} }\nvoid f;`;

test('the emitted dts compiles', async () => {
  const report = await checkSnippetAgainst({ root, source: built.dts, prefixLen: 0, prefixLines: 0, apiIndexPath: join(root, 'plugin-api', 'src', 'index.ts') });
  assert.deepEqual(report.diagnostics.map(d => d.rendered), []);
});

test('a correct composition is clean, several at once included', async () => {
  assert.deepEqual(await check(call(`
    const [review, summary] = await Promise.all([
      tool.single_turn({ prompt: 'Do a code review', context: 'The code is in /work.', tools: true, transcript: true }),
      tool.single_turn({ prompt: 'Summarise the changelog', context: '…', system: 'Be brief.', attach: ['m#0'] }),
    ]);
    console.log((review.messages ?? []).length, summary.text);
    return (review.toolCalls ?? []).map(c => c.name);
  `)), []);
});

test('an unknown field is a compile error that names the field', async () => {
  const found = await check(call(`await tool.single_turn({ prompt: 'x', provder: 'p' });`));
  assert.match(found.join('\n'), /provder/);
});

test('turns is not a field', async () => {
  const found = await check(call(`await tool.single_turn({ prompt: 'x', turns: [{ prompt: 'y' }] });`));
  assert.match(found.join('\n'), /turns/);
});

test('the wire and the validators read the contract', () => {
  const wire = built.contracts['single_turn'];
  assert.ok(wire);
  assert.doesNotMatch(wire.params, /turns/);
  assert.match(wire.params, /prompt: string/, 'the turn is expanded for a model that has only this string');
  const validator = built.validators['single_turn'];
  assert.ok(validator !== undefined && !('refused' in validator), JSON.stringify(validator));
});
