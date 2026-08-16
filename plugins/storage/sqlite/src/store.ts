import { DatabaseSync } from 'node:sqlite';
import type { Store, StoreQuery, QueryResult, CASResult } from '@matatbread/matbot-plugin-api';
import { validateQuery, encodeCursor, decodeCursor, type PageState } from '@matatbread/matbot-core/storage-base';
import { compileFilter, compileOrderBy, type SqlParam } from './query-sql.js';

export class SQLiteStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly db:    DatabaseSync;
  private readonly table: string;

  constructor(db: DatabaseSync, namespace: string) {
    this.db    = db;
    this.table = `${namespace.replace(/[^a-zA-Z0-9]/g, '_')}_store`;
    db.exec(`CREATE TABLE IF NOT EXISTS "${this.table}" (
      id      TEXT PRIMARY KEY NOT NULL,
      version TEXT NOT NULL,
      doc     TEXT NOT NULL
    )`);
  }

  async get(id: string): Promise<T | null> {
    const row = this.db.prepare(`SELECT doc FROM "${this.table}" WHERE id = ?`).get(id) as unknown as { doc: string } | undefined;
    return row !== undefined ? JSON.parse(row.doc) as T : null;
  }

  async set(id: string, value: T): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO "${this.table}" (id, version, doc) VALUES (?, ?, ?)`)
      .run(id, value.version, JSON.stringify(value));
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row     = this.db.prepare(`SELECT version, doc FROM "${this.table}" WHERE id = ?`).get(id) as unknown as { version: string; doc: string } | undefined;
      const current = row !== undefined ? JSON.parse(row.doc) as T : null;
      if (current === null || current.version !== expected) {
        this.db.exec('ROLLBACK');
        return { ok: false, current };
      }
      this.db.prepare(`UPDATE "${this.table}" SET version = ?, doc = ? WHERE id = ?`)
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
        const row = this.db.prepare(`SELECT version FROM "${this.table}" WHERE id = ?`).get(id) as unknown as { version: string } | undefined;
        if (row === undefined || row.version !== expectedVersion) {
          this.db.exec('ROLLBACK');
          return false;
        }
        this.db.prepare(`DELETE FROM "${this.table}" WHERE id = ?`).run(id);
        this.db.exec('COMMIT');
        return true;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    const result = this.db.prepare(`DELETE FROM "${this.table}" WHERE id = ?`).run(id);
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

    const doc   = `"${this.table}".doc`;
    const where = page.where !== undefined ? compileFilter(page.where, doc) : { text: '1', params: [] as SqlParam[] };
    const order = compileOrderBy(page.sort, doc, `"${this.table}".id`);

    // COUNT and the page are two statements, so they are read inside one transaction — otherwise a
    // concurrent writer between them could yield a `total` that does not describe the page returned.
    let total: number;
    let rows:  Array<{ doc: string }>;
    this.db.exec('BEGIN');
    try {
      total = (this.db.prepare(`SELECT COUNT(*) AS n FROM "${this.table}" WHERE ${where.text}`)
        .get(...where.params) as unknown as { n: number }).n;

      // `limit: 0` is the count form — the filter runs and `total` answers, but no row is fetched.
      // SQLite reads a negative LIMIT as unbounded, which is what an absent `limit` means here.
      rows = page.limit === 0 ? [] : this.db.prepare(
        `SELECT doc FROM "${this.table}" WHERE ${where.text} ORDER BY ${order.text} LIMIT ? OFFSET ?`,
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
