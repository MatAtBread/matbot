import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShape, shapeName, shapeType } from '../../../plugins/tool-store/src/shape.ts';

// A store's `shape` is written by the model. It used to be read with `/interface\s+\w+\s*(\{[\s\S]*\})\s*$/`,
// which breaks two ways on source that is otherwise perfectly good TypeScript — and both ways are silent.

test('a comment after the declaration does not lose the shape', () => {
  const shape = 'interface Note {\n  text: string;\n}\n// one note in the store\n';
  assert.equal(shapeType(shape), '{ text: string; }');
  assert.equal(shapeName(shape), 'Note');
});

test('a comment inside the declaration cannot comment out the rest of the contract', () => {
  const doc = shapeType('interface Note {\n  text: string;  // the note body\n  done?: boolean;\n}');
  assert.equal(doc, '{ text: string; done?: boolean; }');
  // The contract is emitted as ONE line, so a surviving `//` would swallow every arm after it.
  assert.ok(!doc.includes('//'), 'a line comment must not reach the collapsed one-line contract');
});

test('a doc comment ahead of the declaration is not mistaken for it', () => {
  assert.equal(shapeType('/** a note. Not an interface X { fake: 1 } */\ninterface Note { text: string }'),
               '{ text: string }');
});

test('a type alias survives trailing prose and a member semicolon', () => {
  assert.equal(shapeType('type Note = { text: string; done: boolean };\n// stored per user\n'),
               '{ text: string; done: boolean }');
  assert.equal(shapeName('type Note = { text: string }'), 'Note');
});

test('a union alias keeps every arm', () => {
  assert.equal(shapeType("type Kind = { k: 'a'; n: number } | { k: 'b'; s: string };"),
               "{ k: 'a'; n: number } | { k: 'b'; s: string }");
});

test('an extends clause is skipped, not parsed as the body', () => {
  assert.equal(shapeType('interface Note extends Base { text: string }'), '{ text: string }');
});

test("a `//` inside a string literal type is not a comment", () => {
  assert.equal(shapeType("interface Link { url: 'https://x' }"), "{ url: 'https://x' }");
});

test('an unparseable shape still degrades to the permissive type', () => {
  assert.equal(shapeType('just some prose'), 'Record<string, unknown>');
  assert.equal(shapeType('interface Broken { text: string'), 'Record<string, unknown>');
  assert.equal(shapeName('just some prose'), undefined);
});

// An unreadable shape yields `Record<string, unknown>` — a document of anything, which validates
// anything. The fallback itself is fine; being SILENT about it is what cost an hour, so `parseShape`
// says why and the create/expose boundary refuses.

test('a shape with no declaration at all reports a fault', () => {
  const { type, fault } = parseShape('a note has a title and a body');
  assert.equal(type, 'Record<string, unknown>');
  assert.match(fault ?? '', /no `interface/);
});

test('an unmatched brace reports a fault rather than degrading quietly', () => {
  const { type, fault } = parseShape('interface Note { text: string');
  assert.equal(type, 'Record<string, unknown>');
  assert.match(fault ?? '', /no matching/);
});

test('`interface X extends Y {}` is a fault, not an empty document type', () => {
  // It MATCHES (the extends-tolerant regex) and inlines only the braces, so the base's members are
  // lost and the emitted type is `{}` — a parse that succeeds and still carries nothing.
  const { type, fault } = parseShape('interface Site extends SiteDetails {}');
  assert.equal(type, 'Record<string, unknown>');
  assert.match(fault ?? '', /extends` is not resolved/);
});

test('a readable shape reports no fault', () => {
  assert.equal(parseShape('interface Note { text: string }\n// trailing prose').fault, undefined);
  assert.equal(parseShape('type Note = { text: string };').fault, undefined);
});
