import { DatabaseSync } from 'node:sqlite';
import type { Store, StoreQuery, QueryResult, CASResult } from '@matatbread/matbot-plugin-api';
import { executeQuery } from '@matatbread/matbot-storage-base';

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

  async query(q: StoreQuery): Promise<QueryResult<T>> {
    const rows = this.db.prepare(`SELECT doc FROM "${this.table}"`).all() as unknown as Array<{ doc: string }>;
    return executeQuery(rows.map(r => JSON.parse(r.doc) as T), q);
  }
}
