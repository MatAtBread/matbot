import type { CASResult, QueryResult, Store, StoreQuery } from '@matatbread/matbot-core';
import { executeQuery } from '@matatbread/matbot-core/storage-base';
import type { DriveClient } from './drive-client.js';

const JSON_MIME = 'application/json';
const SUFFIX    = '.json';

interface Entry<T> {
  doc:    T;
  fileId: string;
}

/**
 * `Store<T>` backed by a single Google Drive folder: one `<id>.json` file per document. Because each
 * Drive round-trip is slow, the whole namespace folder is read into memory once on first access and
 * thereafter served from there; every mutation writes through to Drive and updates the cache. A
 * per-store promise-chain mutex serialises the load and all mutations so concurrent writes can't
 * race the cache or create duplicate-named files (the single-realm analogue of the filesystem
 * store's per-key lock — cross-machine concurrency is out of scope, as it is for the filesystem
 * backend across processes).
 */
export class DriveStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly drive:    DriveClient;
  private readonly folderId: Promise<string>;
  private readonly cache = new Map<string, Entry<T>>();
  private loaded?: Promise<void>;
  private chain:   Promise<unknown> = Promise.resolve();

  constructor(drive: DriveClient, folderId: Promise<string>) {
    this.drive    = drive;
    this.folderId = folderId;
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded !== undefined) return this.loaded;
    this.loaded = (async () => {
      const folder = await this.folderId;
      const files  = await this.drive.list(folder);
      await Promise.all(files.map(async f => {
        if (!f.name.endsWith(SUFFIX)) return;
        const id   = f.name.slice(0, -SUFFIX.length);
        const text = await this.drive.readText(f.id);
        this.cache.set(id, { doc: JSON.parse(text) as T, fileId: f.id });
      }));
    })();
    return this.loaded;
  }

  private lock<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async get(id: string): Promise<T | null> {
    await this.ensureLoaded();
    return this.cache.get(id)?.doc ?? null;
  }

  async set(id: string, value: T): Promise<void> {
    await this.ensureLoaded();
    await this.lock(async () => {
      await this.writeThrough(id, value);
    });
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    await this.ensureLoaded();
    return this.lock(async () => {
      const entry = this.cache.get(id);
      if (entry === undefined)            return { ok: false, current: null };
      if (entry.doc.version !== expected) return { ok: false, current: entry.doc };
      await this.writeThrough(id, next);
      return { ok: true, doc: next };
    });
  }

  async delete(id: string, _expectedVersion?: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.lock(async () => {
      const entry = this.cache.get(id);
      if (entry === undefined) return false;
      await this.drive.deleteFile(entry.fileId);
      this.cache.delete(id);
      return true;
    });
  }

  async query(q: StoreQuery): Promise<QueryResult<T>> {
    await this.ensureLoaded();
    return executeQuery([...this.cache.values()].map(e => e.doc), q);
  }

  /** Create or overwrite the Drive file for `id` and update the cache. Caller holds the lock. */
  private async writeThrough(id: string, value: T): Promise<void> {
    const body  = JSON.stringify(value);
    const entry = this.cache.get(id);
    if (entry !== undefined) {
      await this.drive.updateFile(entry.fileId, body, JSON_MIME);
      this.cache.set(id, { doc: value, fileId: entry.fileId });
      return;
    }
    const folder = await this.folderId;
    const fileId = await this.drive.createFile(`${id}${SUFFIX}`, folder, body, JSON_MIME);
    this.cache.set(id, { doc: value, fileId });
  }
}
