import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContractArms, splitContract } from '@matatbread/matbot-core';

// A `toolContract` string is flattened to the wire's params/result text without a compiler — the browser
// has none, and node does it per registered string. It was two copies of a depth counter that knew neither
// strings nor arrows, so a `|` inside a literal split an arm and the `>` of `=>` closed a bracket.

test('an arrow type inside a contract does not end its bracket', () => {
  assert.deepEqual(
    splitContract('ToolContract<{ map: (x: number) => string }, { action: "a" }> | ToolContract<void, { action: "b" }>'),
    { result: '{ map: (x: number) => string } | void', params: '{ action: "a" } | { action: "b" }' });
});

test('a separator inside a string-literal type does not split', () => {
  assert.deepEqual(
    splitContract("ToolContract<'x|y', { sep: ',' }>"),
    { result: "'x|y'", params: "{ sep: ',' }" });
});

test('a leading | is the multi-line spelling, not an empty arm', () => {
  assert.deepEqual(parseContractArms('\n  | ToolContract<A, B>\n  | ToolContract<C, D>'), { result: 'A | C', params: 'B | D' });
});

test('anything but arms is not a contract', () => {
  assert.equal(parseContractArms('ToolContract<A, B> | string'), null);
  assert.deepEqual(splitContract('string'), { result: 'unknown', params: 'unknown' });
});
