import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildMatbotToolsDts, checkSnippetAgainst } from '@matatbread/matbot-tool-types';

// The third `ToolContract` slot is what lets each of a call's turns type its own result (positionally, by
// whether it has tools and asked for a transcript), and the tool's value in a composed function rests on it. A replica of the proxy type cannot show that it survives what actually
// reaches a body, so this grades snippets against the dts the generator emits, in both directions: if the
// ambient types failed to resolve, everything would be `any` and the bad snippets would pass as well.
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

test('the emitted dts still compiles with a generic call signature in it', async () => {
  const report = await checkSnippetAgainst({ root, source: built.dts, prefixLen: 0, prefixLines: 0, apiIndexPath: join(root, 'plugin-api', 'src', 'index.ts') });
  assert.deepEqual(report.diagnostics.map(d => d.rendered), []);
});

test('a correct composition is clean: positions carried through, tool work and messages where asked for', async () => {
  assert.deepEqual(await check(call(`
    const [review, typecheck, summary] = await tool.single_turn({ turns: [
      { prompt: 'Do a code review', context: 'The code is in /work.', tools: true, transcript: true },
      { prompt: 'Run a typecheck',  context: 'In /work.', tools: true },
      { prompt: 'Summarise the changelog', context: '…', system: 'Be brief.', attach: ['m#0'] },
    ] });
    if (review.ok) console.log(review.messages.length, review.toolCalls[0]?.name);
    if (summary.ok) console.log(summary.text);
    return typecheck.ok ? typecheck.toolCalls.length : typecheck.error;
  `)), []);
});

test('one turn is as it always was: its text, with no ok to check', async () => {
  assert.deepEqual(await check(call(`
    const s = await tool.single_turn({ prompt: 'Classify this', system: 'One word.' });
    const w = await tool.single_turn({ prompt: 'Run the tests', tools: true });
    return s.text + w.toolCalls.length;
  `)), []);
});

test('tool work is not there on a turn without tools', async () => {
  const found = await check(call(`const [s] = await tool.single_turn({ turns: [{ prompt: 'x' }] }); if (s.ok) return s.toolCalls; return [];`));
  assert.match(found.join('\n'), /toolCalls/);
});

test('reading past the end of the turns is a compile error', async () => {
  const found = await check(call(`const [a, b] = await tool.single_turn({ turns: [{ prompt: 'x' }] }); void a; return b.ok;`));
  assert.ok(found.length > 0);
});

test('an unknown turn field is a compile error that names the field', async () => {
  const found = await check(call(`await tool.single_turn({ turns: [{ prompt: 'x', provder: 'p' }] });`));
  assert.match(found.join('\n'), /provder/);
});

test('system on a turn with tools, and transcript on one without, are compile errors', async () => {
  assert.match((await check(call(`await tool.single_turn({ prompt: 'x', tools: true, system: 's' });`))).join('\n'), /system/);
  assert.match((await check(call(`await tool.single_turn({ turns: [{ prompt: 'x', transcript: true }] });`))).join('\n'), /transcript/);
});

test('reading a result in turns before checking ok is a compile error', async () => {
  const found = await check(call(`const [r] = await tool.single_turn({ turns: [{ prompt: 'x' }] }); return r.text;`));
  assert.match(found.join('\n'), /text/);
});

test('messages a turn did not ask for are not there', async () => {
  const found = await check(call(`const [r] = await tool.single_turn({ turns: [{ prompt: 'x', tools: true }] }); if (r.ok) return r.messages.length; return 0;`));
  assert.match(found.join('\n'), /messages/);
});

test('turns built at run time still compile', async () => {
  assert.deepEqual(await check(call(`
    const names: string[] = ['a', 'b'];
    const results = await tool.single_turn({ turns: names.map(n => ({ prompt: n, tools: n === 'a' })) });
    return results.filter(r => r.ok).length;
  `)), []);
});

test('the wire and the validators read the plain forms, not the generic signatures', () => {
  const wire = built.contracts['single_turn'];
  assert.ok(wire, 'a three-argument contract still flattens to wire text');
  assert.match(wire.params, /turns:/);
  assert.match(wire.params, /prompt: string/, 'the turn is expanded for a model that has only this string');
  assert.doesNotMatch(wire.params, /extends|ExactSubTurn/);
  const validator = built.validators['single_turn'];
  assert.ok(validator !== undefined && !('refused' in validator), JSON.stringify(validator));
});
