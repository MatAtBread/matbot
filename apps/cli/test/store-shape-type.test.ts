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

// Three ways a shape that looks fine emitted a wrong type with no fault reported. Each is a silent-emit
// path, which is the failure class this module exists to close.

test('an unterminated quote does not defeat comment stripping', () => {
  // An apostrophe in prose and a string delimiter are the same character, so `Note's` opens a literal
  // that never closes. Treating the rest as inert copied its `//` into the collapsed one-line contract.
  const doc = shapeType("Note's fields:\ninterface Note { text: string; // the body\n done: boolean }");
  assert.equal(doc, '{ text: string; done: boolean }');
  assert.ok(!doc.includes('//'), 'a line comment must not reach the collapsed one-line contract');
});

test('`extends` with a generic type argument does not yield the argument as the body', () => {
  // `[^{]+` stopped at the brace INSIDE the heritage clause, so the base's type argument became the
  // document type — wrong, and reported as good.
  const { type, fault } = parseShape('interface Site extends Base<{ a: string }> { b: number }');
  assert.equal(type, '{ b: number }');
  assert.equal(fault, undefined);
});

test('a function type in an alias is not truncated at its arrow', () => {
  // `=>`'s `>` counted as a closing bracket, dropping the depth a level early, so the next member `;`
  // read as the alias terminator and the type was emitted unbalanced.
  assert.equal(shapeType('type Doc = { f: (x: number) => void; g: string };'),
               '{ f: (x: number) => void; g: string }');
});

test('a string literal type containing // still survives', () => {
  assert.equal(shapeType('interface N { sep: "a//b"; x: string }'), '{ sep: "a//b"; x: string }');
});

test('an interface with no body at all reports a fault', () => {
  assert.match(parseShape('interface Note').fault ?? '', /not followed by a `\{ … \}` body/);
});
