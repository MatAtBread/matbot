import type { CASResult, QueryResult, Store, StoreQuery } from '@matatbread/matbot-core';
import { executeQuery } from '@matatbread/matbot-storage-base';

/** Promisify an IDBRequest. */
function idbPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function openDB(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(storeName, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * `Store<T>` backed by IndexedDB.  Suitable for browser environments. Loads all documents and
 * delegates filtering/sorting/paging to the shared in-memory query engine.
 */
export class IDBStore<T extends { id: string; version: string }> implements Store<T> {
  private dbp: Promise<IDBDatabase>;

  private readonly storeName: string;
  constructor(dbName: string, storeName: string) {
    this.storeName = storeName;
    this.dbp = openDB(dbName, storeName);
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.dbp;
    return db.transaction(this.storeName, mode).objectStore(this.storeName);
  }

  async get(id: string): Promise<T | null> {
    const store = await this.tx('readonly');
    return (await idbPromise(store.get(id) as IDBRequest<T | undefined>)) ?? null;
  }

  async set(id: string, value: T): Promise<void> {
    const store = await this.tx('readwrite');
    await idbPromise(store.put(value));
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    const db    = await this.dbp;
    const tx    = db.transaction(this.storeName, 'readwrite');
    const store = tx.objectStore(this.storeName);

    const current: T | undefined = await idbPromise(store.get(id) as IDBRequest<T | undefined>);

    if (current === undefined) {
      return { ok: false, current: null };
    }
    if (current.version !== expected) {
      return { ok: false, current };
    }

    await idbPromise(store.put(next));
    return { ok: true, doc: next };
  }

  async delete(id: string, _expectedVersion?: string): Promise<boolean> {
    const store   = await this.tx('readwrite');
    const current = await idbPromise(store.get(id) as IDBRequest<T | undefined>);
    if (!current) return false;
    await idbPromise(store.delete(id));
    return true;
  }

  async query(q: StoreQuery): Promise<QueryResult<T>> {
    const store = await this.tx('readonly');
    const all: T[] = await idbPromise(store.getAll() as IDBRequest<T[]>);
    return executeQuery(all, q);
  }
}
