import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, FileStore } from '@matatbread/matbot-plugin-api';
import type { StorageBackend } from '@matatbread/matbot-plugin-api';
import { SQLiteStore } from './store.js';
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

  async close(): Promise<void> {
    this.db.close();
  }
}
