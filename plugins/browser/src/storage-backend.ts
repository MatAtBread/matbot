import type { Store, FileStore, StorageBackend } from '@matatbread/matbot-core';
import { IDBStore }      from './idb-store.js';
import { OPFSFileStore } from './opfs-file-store.js';

/**
 * Refuse to run anywhere that isn't a browser realm. This plugin's whole contract — IndexedDB stores,
 * an OPFS file store — is browser-only, so if a node install accidentally lists it, the storage
 * pre-scan would otherwise swap in a backend that cannot work and brick the config. Throwing here
 * (and in setup) makes the host fall back to its real backend and skip the plugin instead.
 *
 * `process` is referenced via globalThis so this stays free of `@types/node` (the package is
 * platform-neutral); the IndexedDB check is the positive signal, the node check sharpens the message.
 */
export function assertBrowserRealm(): void {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
  if (typeof indexedDB === 'undefined' || node !== undefined) {
    throw new Error(
      '@matatbread/matbot-browser is a browser-only plugin (IndexedDB + OPFS backend) and cannot run under Node' +
      (node !== undefined ? ` (detected Node ${node})` : '') +
      '. Remove it from this installation — the node app already uses the filesystem storage backend by default.',
    );
  }
}

// One IndexedDB database per namespace; the prefix is what makes them enumerable as matbot's.
const DB_PREFIX = 'matbot-';

/**
 * Browser `StorageBackend`: document stores in IndexedDB, files in OPFS — the browser analogue of
 * the node filesystem backend. Each namespace gets its own IndexedDB database (`matbot-<ns>`) with a
 * single `docs` object store, sidestepping the version-1 upgrade race that opening many object
 * stores in one database would hit. Instances are cached per namespace so repeated `createStore`
 * calls reuse one connection.
 *
 * `open()` ignores its `dotData` argument — there is no filesystem path in the browser; the IDB
 * database names and the OPFS `matbot-files` directory are the durable locations.
 */
export class BrowserStorageBackend implements StorageBackend {
  private readonly stores = new Map<string, Store<{ id: string; version: string }>>();
  readonly fileStore: FileStore = new OPFSFileStore();

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    let store = this.stores.get(namespace);
    if (store === undefined) {
      store = new IDBStore<{ id: string; version: string }>(`${DB_PREFIX}${namespace}`, 'docs');
      this.stores.set(namespace, store);
    }
    return store as Store<T>;
  }

  /**
   * Every namespace is its own IndexedDB database named `matbot-<ns>`, so enumerating databases IS
   * enumerating namespaces — no separate registry to keep in step.
   *
   * `indexedDB.databases()` is not universal (older Firefox has no implementation). Where it is
   * missing this **throws** rather than falling back to the namespaces created in this session: that
   * fallback is a lower bound — it omits every namespace no plugin has touched yet — and a caller
   * copying or auditing on the strength of it would silently miss data while reporting success.
   */
  async namespaces(): Promise<string[]> {
    const list = (indexedDB as { databases?: () => Promise<Array<{ name?: string }>> }).databases;
    if (typeof list !== 'function') {
      throw new Error('this browser cannot enumerate IndexedDB databases (indexedDB.databases is unavailable), so the stored namespaces cannot be listed');
    }
    return (await list.call(indexedDB))
      .map(d => d.name)
      .filter((n): n is string => n !== undefined && n.startsWith(DB_PREFIX))
      .map(n => n.slice(DB_PREFIX.length))
      .sort();
  }

  // IndexedDB connections close with the realm; nothing to flush. OPFS writes are durable on close.
  async close(): Promise<void> {}

  static async open(_dotData: string): Promise<BrowserStorageBackend> {
    assertBrowserRealm();
    return new BrowserStorageBackend();
  }
}
