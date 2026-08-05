import type { QueryResult, StoreQuery } from '../store-query.js';

// ── Storage ───────────────────────────────────────────────────────────────────
// The query grammar (Filter AST, StoreQuery, QueryResult, StoreQueryError) lives in ./store-query.

export type CASResult<T> =
  | { ok: true;  doc: T }
  | { ok: false; current: T | null };

export interface Store<T extends { id: string; version: string }> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  cas(id: string, expected: string, next: T): Promise<CASResult<T>>;
  delete(id: string, expectedVersion?: string): Promise<boolean>;
  query(q: StoreQuery): Promise<QueryResult<T>>;
}
