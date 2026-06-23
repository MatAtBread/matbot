// The matbot store query grammar: a minimal, closed filter AST designed to be translated to a
// real backend (SQL WHERE, Elasticsearch bool, Mongo find, IndexedDB cursor) — not interpreted by
// an embedded engine. The in-memory reference evaluator lives in @matatbread/matbot-core/storage-base.
//
// Design rules (see CLAUDE.md / the store-query design notes):
//   - LHS is always a field, RHS is always a constant. No field-vs-field, no computed values.
//   - Operators are a closed union discriminated by `op`, so every backend compiler is one total
//     `switch` the type checker can prove exhaustive.
//   - Comparisons are type-strict; null and absent are a single "missing" state (queried only via
//     `exists`). null is therefore barred from every comparison operand.

export type Scalar     = string | number | boolean | null;  // a STORED value (may be null)
export type Comparable = string | number | boolean;         // Scalar − null  (null → use `exists`)
export type Orderable  = string | number;                   // ordering operands only

// A field reference. A bare string is exactly ONE key (never split on '.'); use an array of
// segments for a nested path. So `"a.b"` is the key literally named `a.b`; `["a","b"]` is nested.
export type FieldPath = string | string[];

export type Filter =
  | { op: 'eq' | 'neq';                field: FieldPath; value: Comparable }
  | { op: 'lt' | 'lte' | 'gt' | 'gte'; field: FieldPath; value: Orderable }
  | { op: 'in' | 'nin';                field: FieldPath; value: Comparable[] }
  | { op: 'exists';                    field: FieldPath; value: boolean }
  | { op: 'stringContains';            field: FieldPath; value: string }
  | { op: 'arrayContains';             field: FieldPath; value: Comparable }
  | { op: 'and' | 'or';                clauses: Filter[] }
  | { op: 'not';                       clause: Filter };

export interface SortSpec {
  field: FieldPath;
  dir:   'asc' | 'desc';
}

// `cursor` is opaque and backend-issued: pass a previous result's `cursor` back to fetch the next
// page. Backends append `id` as a final sort tiebreaker so the order is total (cursor-stable).
export interface StoreQuery {
  where?:  Filter;
  sort?:   SortSpec[];
  limit?:  number;
  cursor?: string;
}

export interface QueryResult<T> {
  items:   T[];
  cursor?: string;   // present iff more pages may follow
  total?:  number;   // optional — omitted by backends that cannot count cheaply
}

export type StoreQueryErrorCode =
  | 'UNKNOWN_OP'      // an `op` outside the closed union
  | 'OPERAND_TYPE'    // operand is the wrong type for the op (e.g. boolean to `gt`)
  | 'NULL_OPERAND'    // null compared directly — use `exists` instead
  | 'EMPTY_FIELD'     // empty field path or empty path segment
  | 'EMPTY_CLAUSES'   // and/or with no clauses
  | 'MALFORMED';      // structurally invalid node (or unreadable cursor)

// Thrown at the query boundary (before any backend touches data) with a JSON pointer into the
// offending node, so an LLM author can locate and fix the clause and retry. Lives in plugin-api
// (a host-shared package) so cross-plugin `instanceof` works — see the plugin hot-reload notes.
export class StoreQueryError extends Error {
  readonly pointer: string;
  readonly code:    StoreQueryErrorCode;
  constructor(message: string, pointer: string, code: StoreQueryErrorCode) {
    super(message);
    this.name    = 'StoreQueryError';
    this.pointer = pointer;
    this.code    = code;
  }
}
