import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, FileStore } from '@matatbread/matbot-plugin-api';
import type { StorageBackend } from '@matatbread/matbot-plugin-api';
import { SQLiteStore, ensureNamespaceRegistry, NAMESPACE_REGISTRY } from './store.js';
import { SQLiteFileStore } from './file-store.js';

export class SQLiteStorageBackend implements StorageBackend {
  private readonly db: DatabaseSync;
  readonly fileStore:  FileStore;

  private constructor(db: DatabaseSync) {
    this.db        = db;
    this.fileStore = new SQLiteFileStore(db);
  }

  static open(dotData: string): Promise<SQLiteStorageBackend> {
    mkdirSync(dotData, { recursive: true });
    const db = new DatabaseSync(join(dotData, 'matbot.db'));
    // WAL mode: readers don't block writers and vice versa.
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    return Promise.resolve(new SQLiteStorageBackend(db));
  }

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    return new SQLiteStore<T>(this.db, namespace);
  }

  /**
   * Read back from the namespace registry, not from `sqlite_master`: the table name is a lossy
   * derivation of the namespace, so the tables alone cannot answer this (see {@link NAMESPACE_REGISTRY}).
   *
   * A namespace holding no rows is omitted, matching the filesystem backend — `createStore` creates
   * the table eagerly, so without the row count every namespace ever touched would be reported as
   * present, and a caller diffing two backends would see phantom entries on the side that merely
   * opened a store.
   */
  async namespaces(): Promise<string[]> {
    ensureNamespaceRegistry(this.db);
    this.backfillRegistry();

    const rows = this.db.prepare(`SELECT tbl, namespace FROM "${NAMESPACE_REGISTRY}"`)
      .all() as unknown as Array<{ tbl: string; namespace: string }>;

    const live: string[] = [];
    for (const { tbl, namespace } of rows) {
      // The registry outlives its table if one is dropped out from under us; treat that as absent
      // rather than letting a stale row fail the whole enumeration.
      try {
        const n = this.db.prepare(`SELECT EXISTS (SELECT 1 FROM "${tbl}") AS any`).get() as unknown as { any: number };
        if (n.any === 1) live.push(namespace);
      } catch { /* table gone */ }
    }
    return live.sort();
  }

  /**
   * Adopt tables created before the registry existed. The namespace is recovered by stripping the
   * `_store` suffix, which is right for every namespace whose characters survived the derivation
   * unchanged — that is, all of them that never contained punctuation. One that did is unrecoverable
   * from an old database and is adopted under its sanitised spelling; it re-registers correctly the
   * moment its owning plugin calls `createStore` again.
   */
  private backfillRegistry(): void {
    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_store' ESCAPE '\\'`,
    ).all() as unknown as Array<{ name: string }>;

    const known = new Set((this.db.prepare(`SELECT tbl FROM "${NAMESPACE_REGISTRY}"`)
      .all() as unknown as Array<{ tbl: string }>).map(r => r.tbl));

    const insert = this.db.prepare(`INSERT OR IGNORE INTO "${NAMESPACE_REGISTRY}" (tbl, namespace) VALUES (?, ?)`);
    for (const { name } of tables) {
      if (!known.has(name)) insert.run(name, name.slice(0, -'_store'.length));
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
