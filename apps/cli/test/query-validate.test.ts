import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuery, executeQuery } from '@matatbread/matbot-core/storage-base';
import { StoreQueryError } from '@matatbread/matbot-core';

// Regression guard for the silently-permissive query envelope. The store query grammar puts the
// filter clause under `where`; LLMs (fed the grammar in every tool-store description) still reach
// for SQL-isms like a top-level `filter` key and a `like` operator. The projection in executeQuery
// keeps only where/sort/limit, so a clause under any other key used to be dropped, the query
// degraded to match-everything, and the author got a plausible full result with no error. The
// envelope must now reject unknown top-level keys before the projection discards them.

type Query = Parameters<typeof validateQuery>[0];
const q = (x: unknown): Query => x as Query;

// The exact hallucinated payload from the field report.
const hallucinated = { filter: { like: [{ field: 'value', value: '%Coume%' }] } };

const docs = [
  { id: '1', version: 'a', value: 'Coume Warren' },
  { id: '2', version: 'b', value: 'something else' },
];

test('unknown top-level key (filter instead of where) is rejected, not silently dropped', () => {
  assert.throws(
    () => validateQuery(q(hallucinated)),
    (e: unknown) =>
      e instanceof StoreQueryError &&
      e.code === 'MALFORMED' &&
      e.pointer === '/filter' &&
      /unknown query key 'filter'/.test(e.message) &&
      /where/.test(e.message),   // the message names the valid keys so the author can self-correct
  );
});

test('executeQuery throws on the hallucinated query rather than returning every document', () => {
  assert.throws(() => executeQuery(docs, q(hallucinated)), (e: unknown) => e instanceof StoreQueryError);
});

test('a `like` operator placed correctly under `where` is a located UNKNOWN_OP', () => {
  assert.throws(
    () => validateQuery(q({ where: { op: 'like', field: 'value', value: '%Coume%' } })),
    (e: unknown) => e instanceof StoreQueryError && e.code === 'UNKNOWN_OP' && e.pointer === '/where/op',
  );
});

test('a non-object query is rejected', () => {
  assert.throws(() => validateQuery(q(null)), (e: unknown) => e instanceof StoreQueryError && e.code === 'MALFORMED');
  assert.throws(() => validateQuery(q([])),   (e: unknown) => e instanceof StoreQueryError && e.code === 'MALFORMED');
});

test('the intended stringContains query still works end-to-end', () => {
  const res = executeQuery(docs, q({ where: { op: 'stringContains', field: 'value', value: 'Coume' } }));
  assert.deepEqual(res.items.map(d => d.id), ['1']);
});

test('an empty query still matches all documents (regression)', () => {
  const res = executeQuery(docs, q({}));
  assert.equal(res.items.length, 2);
});

test('a well-formed query with sort and limit still validates (regression)', () => {
  assert.doesNotThrow(() =>
    validateQuery(q({ where: { op: 'eq', field: 'value', value: 'x' }, sort: [{ field: 'value', dir: 'asc' }], limit: 5 })),
  );
});
