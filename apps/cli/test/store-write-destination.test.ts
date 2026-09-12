import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeDestination } from '../../../plugins/tool-store/src/index.ts';

// ONE invariant: an `id` inside `data` must not contradict the key. Both ways of resolving a
// disagreement are silent and lossy, and `{ ...doc }` carries the id it was read with — so both
// refusals sit on the natural round-trip and both have to name the repair.

const ok = (r: { id: string } | { error: string }): string => {
  assert.ok(!('error' in r), 'error' in r ? r.error : '');
  return (r as { id: string }).id;
};
const err = (r: { id: string } | { error: string }): string => {
  assert.ok('error' in r, `expected a refusal, got id ${(r as { id: string }).id}`);
  return (r as { error: string }).error;
};

test('the key is the top-level id whenever one is given', () => {
  assert.equal(ok(writeDestination('a', { label: 'x' })), 'a');
  assert.equal(ok(writeDestination('a', { label: 'x', id: 'a' })), 'a');   // agreeing: the round-trip
});

test('a contradicting data.id is refused, not discarded', () => {
  // It used to be silently overwritten by the spread order, so a write addressed to `a` accepted and
  // threw away the caller's statement that this document was `zzz`.
  const e = err(writeDestination('a', { label: 'x', id: 'zzz' }));
  assert.match(e, /carries id "zzz"/);
  assert.match(e, /addresses "a"/);
  assert.match(e, /"id": "zzz"/);           // repair 1: write that document
  assert.match(e, /undefined/);             // repair 2: blank it and write here
});

test('a data.id with no key is refused, naming the document it would leave untouched', () => {
  // The natural round-trip minus the key: minting a fresh id creates a duplicate and silently drops
  // the edit the caller meant to make.
  const e = err(writeDestination(undefined, { label: 'x', id: 'a' }));
  assert.match(e, /no top-level "id" was given/);
  assert.match(e, /leave "a" untouched/);
  assert.match(e, /"id": "a" to write that document/);
});

test('an absent or undefined data.id states no opinion', () => {
  // This is what makes `{ ...doc, id: undefined }` the way to say "copy this".
  assert.equal(ok(writeDestination('b', { label: 'x', id: undefined })), 'b');
  const minted = ok(writeDestination(undefined, { label: 'x', id: undefined }));
  assert.equal(minted.length, 36, 'a fresh uuid');
  assert.notEqual(minted, ok(writeDestination(undefined, { label: 'x' })), 'each create mints its own');
});

test('a non-string data.id is not treated as a claim', () => {
  // The contract validator rejects it first; this only has to not mistake it for an id.
  assert.equal(ok(writeDestination('a', { label: 'x', id: 123 })), 'a');
  assert.equal(ok(writeDestination('a', { label: 'x', id: null })), 'a');
});
