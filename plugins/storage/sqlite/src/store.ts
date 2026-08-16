import { DatabaseSync } from 'node:sqlite';
import type { Store, StoreQuery, QueryResult, CASResult } from '@matatbread/matbot-plugin-api';
import { validateQuery, encodeCursor, decodeCursor, type PageState } from '@matatbread/matbot-core/storage-base';
import { compileFilter, compileOrderBy, type SqlParam } from './query-sql.js';

// A namespace's table is its name verbatim, quoted. Every statement here already wraps the table in
// double quotes, so the old derivation — replace every character outside [A-Za-z0-9] with `_` — bought
// no safety and cost injectivity: `a-b` and `a_b` both produced `a_b_store` and SILENTLY SHARED ONE
// TABLE. A quoted identifier holds any namespace at all (spaces, punctuation, unicode, a `"` doubled
// per SQL), so the mangling is simply removed and the mapping is exact in both directions — which is
// also what lets `namespaces()` read `sqlite_master` with no registry to keep in step.
export const TABLE_SUFFIX = '_store';

// SQL identifier quoting: the only escape inside a double-quoted identifier is a doubled quote.
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const legacyTableName = (namespace: string): string =>
  `${namespace.replace(/[^a-zA-Z0-9]/g, '_')}${TABLE_SUFFIX}`;

export class SQLiteStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly db:  DatabaseSync;
  private readonly tbl: string;                              // already quoted — interpolate directly

  constructor(db: DatabaseSync, namespace: string) {
    this.db  = db;
    const table = `${namespace}${TABLE_SUFFIX}`;
    this.tbl = quoteIdent(table);

    // Adopt a table written under the old mangled name. Done here rather than in a migration pass
    // because this is the only place the namespace and its table are both known — the mangling cannot
    // be inverted, so nothing scanning `sqlite_master` alone could pair them up.
    //
    // Only when the exact table is ABSENT and the legacy one is present: a database that already holds
    // both is one where two namespaces were sharing a table (the bug being fixed), and the shared rows
    // follow whichever namespace opens first after the upgrade. There is no better answer available —
    // the rows carry no record of which namespace wrote them.
    const legacy = legacyTableName(namespace);
    if (legacy !== table && !tableExists(db, table) && tableExists(db, legacy)) {
      db.exec(`ALTER TABLE ${quoteIdent(legacy)} RENAME TO ${this.tbl}`);
    }

    db.exec(`CREATE TABLE IF NOT EXISTS ${this.tbl} (
      id      TEXT PRIMARY KEY NOT NULL,
      version TEXT NOT NULL,
      doc     TEXT NOT NULL
    )`);
  }

  async get(id: string): Promise<T | null> {
    const row = this.db.prepare(`SELECT doc FROM ${this.tbl} WHERE id = ?`).get(id) as unknown as { doc: string } | undefined;
    return row !== undefined ? JSON.parse(row.doc) as T : null;
  }

  async set(id: string, value: T): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO ${this.tbl} (id, version, doc) VALUES (?, ?, ?)`)
      .run(id, value.version, JSON.stringify(value));
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row     = this.db.prepare(`SELECT version, doc FROM ${this.tbl} WHERE id = ?`).get(id) as unknown as { version: string; doc: string } | undefined;
      const current = row !== undefined ? JSON.parse(row.doc) as T : null;
      if (current === null || current.version !== expected) {
        this.db.exec('ROLLBACK');
        return { ok: false, current };
      }
      this.db.prepare(`UPDATE ${this.tbl} SET version = ?, doc = ? WHERE id = ?`)
        .run(next.version, JSON.stringify(next), id);
      this.db.exec('COMMIT');
      return { ok: true, doc: next };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    if (expectedVersion !== undefined) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const row = this.db.prepare(`SELECT version FROM ${this.tbl} WHERE id = ?`).get(id) as unknown as { version: string } | undefined;
        if (row === undefined || row.version !== expectedVersion) {
          this.db.exec('ROLLBACK');
          return false;
        }
        this.db.prepare(`DELETE FROM ${this.tbl} WHERE id = ?`).run(id);
        this.db.exec('COMMIT');
        return true;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    const result = this.db.prepare(`DELETE FROM ${this.tbl} WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  // Pushdown, not interpretation: the query is compiled to SQL and SQLite answers it. The shape
  // mirrors the in-memory reference exactly — validate the RAW query (so an unknown top-level key is
  // reported rather than silently dropped), resolve the page, validate a decoded cursor as the
  // untrusted input it is — and then diverges only at the point where the reference would filter and
  // slice an array.
  async query(q: StoreQuery): Promise<QueryResult<T>> {
    validateQuery(q);

    const page: PageState = q.cursor !== undefined
      ? decodeCursor(q.cursor)
      : {
          offset: 0,
          ...(q.where !== undefined ? { where: q.where } : {}),
          ...(q.sort  !== undefined ? { sort:  q.sort  } : {}),
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
        };

    if (q.cursor !== undefined) validateQuery({
      ...(page.where !== undefined ? { where: page.where } : {}),
      ...(page.sort  !== undefined ? { sort:  page.sort  } : {}),
      ...(page.limit !== undefined ? { limit: page.limit } : {}),
    });

    const doc   = `${this.tbl}.doc`;
    const where = page.where !== undefined ? compileFilter(page.where, doc) : { text: '1', params: [] as SqlParam[] };
    const order = compileOrderBy(page.sort, doc, `${this.tbl}.id`);

    // COUNT and the page are two statements, so they are read inside one transaction — otherwise a
    // concurrent writer between them could yield a `total` that does not describe the page returned.
    let total: number;
    let rows:  Array<{ doc: string }>;
    this.db.exec('BEGIN');
    try {
      total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.tbl} WHERE ${where.text}`)
        .get(...where.params) as unknown as { n: number }).n;

      // `limit: 0` is the count form — the filter runs and `total` answers, but no row is fetched.
      // SQLite reads a negative LIMIT as unbounded, which is what an absent `limit` means here.
      rows = page.limit === 0 ? [] : this.db.prepare(
        `SELECT doc FROM ${this.tbl} WHERE ${where.text} ORDER BY ${order.text} LIMIT ? OFFSET ?`,
      ).all(...where.params, ...order.params, page.limit ?? -1, page.offset) as unknown as Array<{ doc: string }>;
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    // The count form issues no cursor: a zero-length page never advances the offset, so a caller
    // paging on one would loop forever on the same empty slice.
    const next = page.offset + rows.length;
    return {
      items: rows.map(r => JSON.parse(r.doc) as T),
      total,
      ...(page.limit !== 0 && next < total ? { cursor: encodeCursor({ ...page, offset: next }) } : {}),
    };
  }
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}
