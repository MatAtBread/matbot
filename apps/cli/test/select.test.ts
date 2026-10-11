import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerSelect, renderSelect, resolveSelect } from '../src/select.ts';
import type { FormOption } from '@matatbread/matbot-core';

// What is SHOWN is the only addressing scheme the reader has, so rendering and resolving have to agree.
// A label prefix was the whole of it, which was fine while every select was two or three short words and
// stopped being fine when the permission gate started offering standing answers as prose.

const SHORT: FormOption[] = ['yes', 'no'];
// The gate's own shape: four "Always allow …" labels sharing ~50 characters.
const GATE: FormOption[] = [
  { value: 'deny',      label: 'Deny' },
  { value: 'allow',     label: 'Allow' },
  { value: 'always-0',  label: 'Always allow function "fetch_prices" to import node:fs/promises' },
  { value: 'always-1',  label: 'Always allow function "fetch_prices" to import anything under node:fs/' },
  { value: 'always-2',  label: 'Always allow function "fetch_prices" to import any node builtin' },
  { value: 'always-3',  label: 'Always allow ANY function to import node:fs/promises' },
  { value: 'always-gate', label: 'Always allow every tool_function.import' },
];

test('a short select keeps the inline form, with the default shouted', () => {
  const { lines, hint } = renderSelect(SHORT, 'no');
  assert.deepEqual(lines, [], 'nothing to list: the hint says it all');
  assert.equal(hint, 'yes/NO');
});

test('a long one is numbered, because the prompt cannot carry it', () => {
  const { lines, hint } = renderSelect(GATE, 'deny');
  assert.equal(hint, '1-7');
  assert.match(lines[0]!, /^ {2}1\) Deny {2}\(default\)$/);
  assert.match(lines[3]!, /^ {2}4\) Always allow function "fetch_prices" to import anything under node:fs\/$/);
  assert.equal(lines.length, GATE.length);
});

test('a number addresses an option that no prefix could reach', () => {
  // The point of the whole change. These four labels share 48 characters, so the only way to type one
  // was to type all of it exactly — and a near-miss used to resolve to the field's default, which here
  // is Deny: a typo read as a refusal, with nothing said.
  assert.equal(resolveSelect(GATE, '4', true), 'always-1');
  assert.equal(resolveSelect(GATE, '7', true), 'always-gate');
  assert.equal(resolveSelect(GATE, '8', true), undefined, 'out of range is a miss, not the last option');
  assert.equal(resolveSelect(GATE, '0', true), undefined);
});

test('a number is an address only where numbers were SHOWN, and never beats the option itself', () => {
  // `ask_user` may offer numeric options, and the inline form displays no numbers at all: reading `2` as
  // a position there answered `4` to a question nobody asked, and rejected `8` as not an option.
  const sizes: FormOption[] = ['2', '4', '8'];
  assert.equal(renderSelect(sizes, undefined).numbered, false, 'short enough to stay inline');
  for (const v of sizes) assert.equal(resolveSelect(sizes, v), v);
  assert.equal(resolveSelect(sizes, '3'), undefined, 'not an option, and not "the third one"');
  // Even when the list IS numbered, the option's own text wins — it is what the reader is looking at.
  assert.equal(resolveSelect(sizes, '2', true), '2');
  assert.equal(resolveSelect(sizes, '3', true), '8', 'no option says 3, so the position answers');
});

test('an exact value or label resolves, and a unique prefix does', () => {
  assert.equal(resolveSelect(GATE, 'always-1'), 'always-1', 'the value, which is what a frontend has');
  assert.equal(resolveSelect(GATE, 'deny'), 'deny');
  assert.equal(resolveSelect(GATE, 'den'), 'deny');
  assert.equal(resolveSelect(SHORT, 'y'), 'yes');
});

test('an ambiguous prefix is a miss, never the first match', () => {
  // Resolving it to the first match is exactly how a shared prefix picked an answer nobody chose.
  assert.equal(resolveSelect(GATE, 'Always allow'), undefined);
  assert.equal(resolveSelect(GATE, 'always-'), undefined);
  assert.equal(resolveSelect(GATE, 'a'), undefined, 'Allow and four Always answers');
  // …while a prefix that reaches exactly one still works, however long the shared part was.
  assert.equal(resolveSelect(GATE, 'Always allow ANY'), 'always-3');
  assert.equal(resolveSelect(GATE, 'allow'), 'allow', 'an exact match beats being a prefix of others');
});

test('nothing typed is not a resolution', () => {
  // The caller treats an empty line as "take the default", which is a different thing from a miss.
  assert.equal(resolveSelect(GATE, ''), undefined);
  assert.equal(resolveSelect(GATE, '   '), undefined);
});

// ── what to do with one typed line ───────────────────────────────────────────

test('an empty line takes the default; a miss says so and asks again, once', () => {
  assert.deepEqual(answerSelect(GATE, '', { def: 'deny' }), { answer: 'deny' });
  assert.deepEqual(answerSelect(GATE, '   ', {}), { answer: '' }, 'no default: nothing');
  // A miss is not a decision, and for a gate the default is Deny — so taking it silently read a typo as
  // a refusal, with nothing said.
  const first = answerSelect(GATE, 'alwys', { def: 'deny', numbered: true });
  assert.ok('retry' in first && /not one of the options — type its number/.test(first.retry));
  // Once only: a caller may not be interactive at all.
  assert.deepEqual(answerSelect(GATE, 'alwys', { def: 'deny', numbered: true, again: true }), { answer: 'deny' });
  assert.deepEqual(answerSelect(GATE, '3', { def: 'deny', numbered: true }), { answer: 'always-0' });
});

test('with allowOther the free text IS the answer, default or no default', () => {
  // `ask_user`'s documented behaviour, and what the web frontend does. Collapsing every unmatched answer
  // onto the default made this door return the default — or an empty string — for anything typed.
  assert.deepEqual(answerSelect(SHORT, 'maybe', { allowOther: true }), { answer: 'maybe' });
  assert.deepEqual(answerSelect(SHORT, 'maybe', { allowOther: true, def: 'no' }), { answer: 'maybe' },
                   'the default does not outrank what was actually typed');
  // It is never questioned, so there is no re-ask to sit through.
  assert.ok('answer' in answerSelect(SHORT, 'maybe', { allowOther: true }));
  // An option still resolves normally — allowOther widens the answers, it does not stop matching.
  assert.deepEqual(answerSelect(SHORT, 'y', { allowOther: true }), { answer: 'yes' });
  // …and an empty line still means the default, not an empty free-text answer.
  assert.deepEqual(answerSelect(SHORT, '', { allowOther: true, def: 'no' }), { answer: 'no' });
});
