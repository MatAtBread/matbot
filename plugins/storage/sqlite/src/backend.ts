import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, FileStore } from '@matatbread/matbot-plugin-api';
import type { StorageBackend } from '@matatbread/matbot-plugin-api';
import { SQLiteStore, quoteIdent, TABLE_SUFFIX } from './store.js';
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
   * Read straight from `sqlite_master`: a namespace's table is its name verbatim, so stripping the
   * suffix inverts exactly and there is no registry to keep in step (see {@link SQLiteStore}).
   *
   * A namespace holding no rows is omitted, matching the filesystem backend — `createStore` creates
   * the table eagerly, so counting rows is what separates "holds documents" from "was once opened".
   */
  async namespaces(): Promise<string[]> {
    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`,
    ).all(`%\\${TABLE_SUFFIX}`) as unknown as Array<{ name: string }>;

    const live: string[] = [];
    for (const { name } of tables) {
      const n = this.db.prepare(`SELECT EXISTS (SELECT 1 FROM ${quoteIdent(name)}) AS present`)
        .get() as unknown as { present: number };
      if (n.present === 1) live.push(name.slice(0, -TABLE_SUFFIX.length));
    }
    return live.sort();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
