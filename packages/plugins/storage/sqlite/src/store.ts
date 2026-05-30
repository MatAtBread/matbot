import { DatabaseSync } from 'node:sqlite';
import type { Store, StoreQuery, QueryResult, CASResult } from '@matatbread/matbot-plugin-api';
import { matchFilter, applySort, cosineSimilarity } from '@matatbread/matbot-storage-base';

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

  async query(q: StoreQuery<T>): Promise<QueryResult<T>> {
    const rows    = this.db.prepare(`SELECT doc FROM "${this.table}"`).all() as unknown as Array<{ doc: string }>;
    let pool      = rows.map(r => JSON.parse(r.doc) as T);
    let filtered  = q.filter !== undefined ? pool.filter(d => matchFilter(d, q.filter!)) : pool;

    if (q.fullText !== undefined) {
      const term = q.fullText.toLowerCase();
      filtered = filtered.filter(d => JSON.stringify(d).toLowerCase().includes(term));
    }

    type Item = QueryResult<T>['items'][number];
    let page:  Item[];
    let total: number;

    if (q.vector?.embedding !== undefined) {
      const { embedding, topK, minScore = 0, preFilter } = q.vector;
      const candidates = preFilter !== undefined ? filtered.filter(d => matchFilter(d, preFilter)) : filtered;
      const ranked = candidates
        .map(doc => ({ doc, score: cosineSimilarity(embedding, extractEmbedding(doc)) }))
        .filter(({ score }) => score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      total       = ranked.length;
      const off   = q.offset ?? 0;
      const slice = q.limit !== undefined ? ranked.slice(off, off + q.limit) : ranked.slice(off);
      page = slice.map(({ doc, score }): Item => ({ doc, score }));
    } else {
      if (q.sort !== undefined && q.sort.length > 0) filtered = applySort(filtered, q.sort);
      total       = filtered.length;
      const off   = q.offset ?? 0;
      const slice = q.limit !== undefined ? filtered.slice(off, off + q.limit) : filtered.slice(off);
      page = slice.map((doc): Item => ({ doc }));
    }

    return { items: page, total };
  }
}

function extractEmbedding(doc: unknown): number[] {
  if (doc !== null && typeof doc === 'object') {
    const e = (doc as Record<string, unknown>)['embedding'];
    if (Array.isArray(e)) return e as number[];
  }
  return [];
}
