import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeQuery } from '@matatbread/matbot-core/storage-base';
import { StoreQueryError } from '@matatbread/matbot-core';
import { SQLiteStorageBackend } from '../../../plugins/storage/sqlite/src/backend.ts';
import type { StoreQuery, Store } from '@matatbread/matbot-plugin-api';

// The StoreQuery grammar claims to be a translation target rather than an engine: the SQLite backend
// compiles it to SQL instead of loading the namespace into memory. That claim is only worth anything
// if the two answer identically, so this is one corpus run against both — the in-memory reference and
// the pushdown — asserting the SAME documents in the SAME order for every query.
//
// The corpus is deliberately built around the places the translation could go quietly wrong, because
// SQL's defaults disagree with the grammar's at all of them: three-valued logic under `not`, JSON
// null vs absent, type-strictness (json_extract erases a boolean to 0/1), NULL ordering under DESC,
// and field paths containing the JSON-path metacharacters.

interface Doc {
  id:       string;
  version:  string;
  name?:    string | null;
  size?:    number;
  // `flag` and `tags` deliberately hold booleans AND numbers across documents: `json_extract` erases
  // a JSON boolean to the integer 0/1, so without a document storing a real 1 here, a backend that
  // dropped the `json_type` guard would agree with the reference on every query and the corpus would
  // certify a bug. Same for `tags` and `arrayContains`.
  flag?:    boolean | number;
  tags?:    Array<string | number | boolean>;
  nested?:  { deep?: { value?: number } };
  'a.b'?:   string;   // a key literally containing a dot — ONE segment, never a path
  'we"ird'?: string;
}

const docs: Doc[] = [
  { id: 'd1', version: 'v1', name: 'alpha',   size: 10,  flag: true,  tags: ['red', 'blue'], nested: { deep: { value: 1 } }, 'a.b': 'dotted' },
  { id: 'd2', version: 'v1', name: 'beta',    size: 2,   flag: false, tags: ['blue'],        nested: { deep: {} } },
  { id: 'd3', version: 'v1', name: 'Gamma',   size: 100,                tags: [],              nested: {} },
  { id: 'd4', version: 'v1', name: null,      size: 10,  flag: true,  tags: ['red', 7] },
  { id: 'd5', version: 'v1',                  flag: true },
  { id: 'd6', version: 'v1', name: '10',      size: 0,   tags: ['10'], 'we"ird': 'quoted' },
  { id: 'd7', version: 'v1', name: 'alphabet', size: -5, flag: false },
  { id: 'd8', version: 'v1', name: 'delta',   size: 1,   flag: 1,     tags: [true, 1] },
  { id: 'd9', version: 'v1', name: 'epsilon', size: 3,   flag: 0,     tags: [false, 'true'] },
  // Numbers WITHOUT the booleans they erase to, so `arrayContains true` and `arrayContains 1` have
  // different answers — the only way the element type guard is falsifiable (see query-sql.ts).
  { id: 'd10', version: 'v1', name: 'zeta',   size: 1,                tags: [1, 0] },
];

const queries: Array<[string, StoreQuery]> = [
  ['match everything',                  {}],
  ['eq string',                         { where: { op: 'eq', field: 'name', value: 'alpha' } }],
  ['eq number',                         { where: { op: 'eq', field: 'size', value: 10 } }],
  ['eq true excludes a stored 1',       { where: { op: 'eq', field: 'flag', value: true } }],
  ['eq 1 excludes a stored true',       { where: { op: 'eq', field: 'flag', value: 1 } }],
  ['eq false excludes a stored 0',      { where: { op: 'eq', field: 'flag', value: false } }],
  ['eq 0 excludes a stored false',      { where: { op: 'eq', field: 'flag', value: 0 } }],
  ['gt 0 never matches a boolean',      { where: { op: 'gt', field: 'flag', value: 0 } }],
  ['eq "10" does not match 10',         { where: { op: 'eq', field: 'size', value: '10' } }],
  ['eq on a stringified number',        { where: { op: 'eq', field: 'name', value: '10' } }],
  ['eq on a JSON null field',           { where: { op: 'eq', field: 'name', value: 'x' } }],
  ['neq excludes missing and null',     { where: { op: 'neq', field: 'name', value: 'alpha' } }],
  ['neq on a boolean',                  { where: { op: 'neq', field: 'flag', value: true } }],
  ['lt number',                         { where: { op: 'lt', field: 'size', value: 10 } }],
  ['lte number',                        { where: { op: 'lte', field: 'size', value: 10 } }],
  ['gt number',                         { where: { op: 'gt', field: 'size', value: 0 } }],
  ['gte negative',                      { where: { op: 'gte', field: 'size', value: -5 } }],
  ['gt string is codepoint order',      { where: { op: 'gt', field: 'name', value: 'alpha' } }],
  ['gt string vs uppercase',            { where: { op: 'gt', field: 'name', value: 'G' } }],
  ['gt across types never matches',     { where: { op: 'gt', field: 'name', value: 0 } }],
  ['in strings',                        { where: { op: 'in', field: 'name', value: ['alpha', 'beta', 'nope'] } }],
  ['in mixed types',                    { where: { op: 'in', field: 'size', value: [10, '10', 0] } }],
  ['in empty list matches nothing',     { where: { op: 'in', field: 'name', value: [] } }],
  ['nin excludes missing',              { where: { op: 'nin', field: 'name', value: ['alpha'] } }],
  ['nin empty list is present',         { where: { op: 'nin', field: 'name', value: [] } }],
  ['exists true excludes JSON null',    { where: { op: 'exists', field: 'name', value: true } }],
  ['exists false includes JSON null',   { where: { op: 'exists', field: 'name', value: false } }],
  ['exists on a nested path',           { where: { op: 'exists', field: ['nested', 'deep', 'value'], value: true } }],
  ['exists false on a nested path',     { where: { op: 'exists', field: ['nested', 'deep', 'value'], value: false } }],
  ['nested eq',                         { where: { op: 'eq', field: ['nested', 'deep', 'value'], value: 1 } }],
  ['stringContains',                    { where: { op: 'stringContains', field: 'name', value: 'lpha' } }],
  ['stringContains is case sensitive',  { where: { op: 'stringContains', field: 'name', value: 'GAM' } }],
  ['stringContains empty needle',       { where: { op: 'stringContains', field: 'name', value: '' } }],
  ['stringContains does not see numbers', { where: { op: 'stringContains', field: 'size', value: '10' } as never }],
  ['arrayContains string',              { where: { op: 'arrayContains', field: 'tags', value: 'red' } }],
  ['arrayContains is type strict',      { where: { op: 'arrayContains', field: 'tags', value: '7' } }],
  ['arrayContains number element',      { where: { op: 'arrayContains', field: 'tags', value: 7 } }],
  ['arrayContains true excludes 1',     { where: { op: 'arrayContains', field: 'tags', value: true } }],
  ['arrayContains 1 excludes true',     { where: { op: 'arrayContains', field: 'tags', value: 1 } }],
  ['arrayContains false excludes "false"', { where: { op: 'arrayContains', field: 'tags', value: false } }],
  ['arrayContains "true" excludes true', { where: { op: 'arrayContains', field: 'tags', value: 'true' } }],
  ['not arrayContains true',            { where: { op: 'not', clause: { op: 'arrayContains', field: 'tags', value: true } } }],
  ['arrayContains on a non-array',      { where: { op: 'arrayContains', field: 'name', value: 'alpha' } }],
  ['a dot in a key is one segment',     { where: { op: 'eq', field: 'a.b', value: 'dotted' } }],
  ['a dotted key is not a path',        { where: { op: 'eq', field: ['a', 'b'], value: 'dotted' } }],
  ['a quote in a key',                  { where: { op: 'eq', field: 'we"ird', value: 'quoted' } }],
  ['and',                               { where: { op: 'and', clauses: [{ op: 'eq', field: 'flag', value: true }, { op: 'eq', field: 'size', value: 10 }] } }],
  ['or',                                { where: { op: 'or', clauses: [{ op: 'eq', field: 'name', value: 'beta' }, { op: 'gt', field: 'size', value: 50 }] } }],

  // The three-valued-logic traps: SQL would make each of these NULL, not false, and drop rows the
  // grammar keeps. A row MISSING the field must match every negated predicate over it.
  ['not eq keeps missing rows',         { where: { op: 'not', clause: { op: 'eq', field: 'name', value: 'alpha' } } }],
  ['not gt keeps missing rows',         { where: { op: 'not', clause: { op: 'gt', field: 'size', value: 5 } } }],
  ['not stringContains keeps missing',  { where: { op: 'not', clause: { op: 'stringContains', field: 'name', value: 'a' } } }],
  ['not arrayContains keeps missing',   { where: { op: 'not', clause: { op: 'arrayContains', field: 'tags', value: 'red' } } }],
  ['not exists',                        { where: { op: 'not', clause: { op: 'exists', field: 'flag', value: true } } }],
  ['not in',                            { where: { op: 'not', clause: { op: 'in', field: 'size', value: [10, 2] } } }],
  ['not of and',                        { where: { op: 'not', clause: { op: 'and', clauses: [{ op: 'exists', field: 'size', value: true }, { op: 'gt', field: 'size', value: 5 }] } } }],
  ['not not',                           { where: { op: 'not', clause: { op: 'not', clause: { op: 'eq', field: 'flag', value: true } } } }],

  // Ordering: missing sorts last ASC, which means FIRST under DESC — a property of the value, where
  // SQL's NULL ordering is a property of the direction.
  ['sort asc puts missing last',        { sort: [{ field: 'size', dir: 'asc' }] }],
  ['sort desc puts missing first',      { sort: [{ field: 'size', dir: 'desc' }] }],
  ['sort by text',                      { sort: [{ field: 'name', dir: 'asc' }] }],
  ['sort by text desc',                 { sort: [{ field: 'name', dir: 'desc' }] }],
  ['sort by boolean sorts as text',     { sort: [{ field: 'flag', dir: 'asc' }] }],
  ['sort by boolean desc',              { sort: [{ field: 'flag', dir: 'desc' }] }],
  ['sort by nested path',               { sort: [{ field: ['nested', 'deep', 'value'], dir: 'asc' }] }],
  ['multi-key sort',                    { sort: [{ field: 'flag', dir: 'desc' }, { field: 'size', dir: 'asc' }] }],
  ['sort with filter',                  { where: { op: 'exists', field: 'size', value: true }, sort: [{ field: 'size', dir: 'desc' }] }],

  ['limit',                             { limit: 3 }],
  ['limit with sort',                   { limit: 2, sort: [{ field: 'size', dir: 'asc' }] }],
  ['limit larger than the store',       { limit: 99 }],
  ['count form',                        { limit: 0 }],
  ['count form with a filter',          { where: { op: 'eq', field: 'flag', value: true }, limit: 0 }],
];

async function withStore(fn: (sqlite: Store<Doc>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-query-sql-'));
  const backend = await SQLiteStorageBackend.open(dir);
  try {
    const store = backend.createStore<Doc>('conformance');
    // Inserted OUT of id order on purpose. The grammar appends `id` as a final sort tiebreaker so the
    // order is total (without which a cursor cannot point at a stable boundary), and this corpus has
    // real ties on every sorted field. Inserted in id order, SQLite's scan order would coincide with
    // that tiebreak and a backend that omitted it would still agree — certifying an unstable order.
    for (const d of [...docs].reverse()) await store.set(d.id, d);
    await fn(store);
  } finally {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('every query returns the same documents, in the same order, from both backends', async () => {
  await withStore(async store => {
    for (const [label, q] of queries) {
      const reference = executeQuery(docs, q);
      const pushdown  = await store.query(q);
      assert.deepEqual(
        pushdown.items.map(d => d.id), reference.items.map(d => d.id),
        `${label}: SQL pushdown disagreed with the in-memory reference`,
      );
      assert.equal(pushdown.total, reference.total, `${label}: total disagreed`);
      assert.deepEqual(pushdown.items, reference.items, `${label}: documents did not round-trip intact`);
    }
  });
});

test('paging with a cursor covers the store exactly once, in sorted order', async () => {
  await withStore(async store => {
    for (const sort of [undefined, [{ field: 'size' as const, dir: 'desc' as const }]]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page: StoreQuery = cursor !== undefined
          ? { cursor }
          : { limit: 2, ...(sort !== undefined ? { sort } : {}) };
        const res = await store.query(page);
        assert.ok(res.items.length <= 2, 'a page must not exceed the requested size');
        seen.push(...res.items.map(d => d.id));
        cursor = res.cursor;
      } while (cursor !== undefined);

      const reference = executeQuery(docs, sort !== undefined ? { sort } : {});
      assert.deepEqual(seen, reference.items.map(d => d.id), 'paging must be a disjoint cover in total order');
    }
  });
});

test('the count form issues no cursor', async () => {
  await withStore(async store => {
    const res = await store.query({ limit: 0 });
    assert.deepEqual(res.items, []);
    assert.equal(res.total, docs.length);
    assert.equal(res.cursor, undefined, 'a zero-length page would page forever on the same empty slice');
  });
});

// Validation is the grammar's, not the backend's: pushdown must reject exactly what the reference
// rejects, and BEFORE it touches the database — otherwise a malformed clause reaches SQLite as an
// unconstrained scan and the author gets a plausible result instead of a located error.
test('an invalid query is rejected at the boundary with the same located error', async () => {
  await withStore(async store => {
    const bad: Array<[string, unknown, string]> = [
      ['unknown op',        { where: { op: 'like', field: 'name', value: 'a' } },  '/where/op'],
      ['null operand',      { where: { op: 'eq', field: 'name', value: null } },   '/where/value'],
      ['unknown query key', { filter: { op: 'eq', field: 'name', value: 'a' } },   '/filter'],
      ['empty field path',  { where: { op: 'eq', field: [], value: 'a' } },        '/where/field'],
      ['negative limit',    { limit: -1 },                                          '/limit'],
      ['unreadable cursor', { cursor: 'not-a-cursor' },                             '/cursor'],
    ];
    for (const [label, q, pointer] of bad) {
      await assert.rejects(
        () => store.query(q as StoreQuery),
        (e: unknown) => e instanceof StoreQueryError && e.pointer === pointer,
        `${label}: expected a StoreQueryError at ${pointer}`,
      );
      assert.throws(() => executeQuery(docs, q as StoreQuery), StoreQueryError, `${label}: reference must reject it too`);
    }
  });
});
