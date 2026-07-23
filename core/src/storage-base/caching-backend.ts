import type {
  Store, StorageBackend, FileStore, StoreQuery, QueryResult, CASResult,
} from '@matatbread/matbot-plugin-api';
import { executeQuery } from './query/execute.js';

export interface CachingOptions {
  /**
   * Bounded-staleness ceiling for FOREIGN writes — another process/tab/host mutating the same backing
   * store behind our back. When set, a namespace's in-memory image is treated as stale this many ms
   * after it was warmed and re-loaded on the next read. Own writes are always coherent regardless
   * (write-through keeps the image in step), so a strictly single-writer deployment can leave this
   * unset. Undefined ⇒ warm once and never expire on time.
   *
   * TTL is the *portable* invalidation tier — every backing store supports it. A backing store that
   * also exposes a change feed (Node `fs.watch`, the Drive Changes API, Postgres `LISTEN/NOTIFY`)
   * could drive sharper foreign-write invalidation by evicting `image` on a remote change event; that
   * is a later, opt-in refinement layered on top of this and deliberately NOT required here.
   */
  ttlMs?: number;
}

/** Per-namespace cache counters, for answering "is the cache actually saving reads?" — see
 *  {@link CachingStorageBackend.stats}. `reads` is get()+query() calls; `hits` is the subset served
 *  from the warm image without touching the backing store; `loads` is full-namespace warms/refreshes
 *  (the expensive round-trips); `lastLoadMs` times the most recent one; `docs` is the current image
 *  size. A healthy cache shows `hits` climbing while `loads` stays flat (typically 1). */
export interface CacheNamespaceStats {
  docs:       number;
  reads:      number;
  hits:       number;
  loads:      number;
  lastLoadMs: number;
}

/**
 * Cache-aside, write-through caching Store. Reads serve from a full in-memory image of the namespace
 * (`Map<id, T>`), warmed lazily by a single `backing.query({})`; every write goes to the backing store
 * first (the system of record — CAS and durability stay there) and then updates the image on success.
 *
 * Coherence is honest: always coherent with THIS store's own writes; foreign writes only as sharp as
 * the {@link CachingOptions.ttlMs} tier (never, if unset). That is the single-writer assumption made
 * explicit at one layer — a backend that cannot assume it simply isn't wrapped, or wraps with a short
 * TTL.
 */
class CachingStore<T extends { id: string; version: string }> implements Store<T> {
  private image: Map<string, T> | undefined;
  private warmedAt = 0;
  private warming: Promise<Map<string, T>> | undefined;

  private readonly backing: Store<T>;
  private readonly ttlMs:   number | undefined;

  private reads = 0;
  private hits  = 0;
  private loads = 0;
  private lastLoadMs = 0;

  constructor(backing: Store<T>, ttlMs: number | undefined) {
    this.backing = backing;
    this.ttlMs   = ttlMs;
  }

  get stats(): CacheNamespaceStats {
    return { docs: this.image?.size ?? 0, reads: this.reads, hits: this.hits, loads: this.loads, lastLoadMs: this.lastLoadMs };
  }

  private fresh(): boolean {
    if (this.image === undefined) return false;
    if (this.ttlMs === undefined) return true;
    return Date.now() - this.warmedAt < this.ttlMs;
  }

  // Serve the whole-namespace image, (re)loading it when cold or TTL-stale. Concurrent callers share
  // one in-flight load rather than each firing their own `query({})`.
  private warm(): Promise<Map<string, T>> {
    if (this.image !== undefined && this.fresh()) { this.hits++; return Promise.resolve(this.image); }
    return (this.warming ??= this.load());
  }

  private async load(): Promise<Map<string, T>> {
    const started = Date.now();
    try {
      const { items } = await this.backing.query({});
      const map = new Map<string, T>(items.map(d => [d.id, d]));
      this.image      = map;
      this.warmedAt   = Date.now();
      this.loads++;
      this.lastLoadMs = Date.now() - started;
      return map;
    } finally {
      this.warming = undefined;
    }
  }

  async get(id: string): Promise<T | null> {
    this.reads++;
    return (await this.warm()).get(id) ?? null;
  }

  async query(q: StoreQuery): Promise<QueryResult<T>> {
    this.reads++;
    return executeQuery([...(await this.warm()).values()], q);
  }

  async set(id: string, value: T): Promise<void> {
    await this.backing.set(id, value);
    this.image?.set(id, value);
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    const result = await this.backing.cas(id, expected, next);
    if (this.image !== undefined) {
      if (result.ok) this.image.set(id, next);
      // Conflict: the backing store hands back the authoritative current doc — reconcile the image so a
      // retry (and the caller inspecting `current`) sees truth, not our stale copy.
      else if (result.current !== null) this.image.set(id, result.current);
      else this.image.delete(id);
    }
    return result;
  }

  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    const ok = await this.backing.delete(id, expectedVersion);
    if (ok) this.image?.delete(id);
    return ok;
  }
}

/**
 * Wraps any {@link StorageBackend} in a per-namespace read-through cache — see {@link CachingStore}.
 * Compose it BELOW any principal-partitioning router (e.g. the profiles backend) so each partition
 * gets its own cache and the cache never sees a blended, principal-blind view; a slow backend
 * (browser Google Drive) wraps its own backend before registering. File blobs pass straight through
 * uncached (large, and read far less often than documents).
 */
export class CachingStorageBackend implements StorageBackend {
  readonly inner: StorageBackend;
  private readonly ttlMs:  number | undefined;
  private readonly stores = new Map<string, CachingStore<{ id: string; version: string }>>();

  constructor(inner: StorageBackend, options: CachingOptions = {}) {
    this.inner = inner;
    this.ttlMs = options.ttlMs;
  }

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    let store = this.stores.get(namespace);
    if (store === undefined) {
      store = new CachingStore(this.inner.createStore(namespace), this.ttlMs);
      this.stores.set(namespace, store);
    }
    return store as unknown as Store<T>;
  }

  /** Per-namespace cache counters (only namespaces touched so far). A diagnostic surface — read it to
   *  confirm the cache is serving reads (`hits` up, `loads` ~1) rather than re-reading the backend. */
  stats(): Record<string, CacheNamespaceStats> {
    const out: Record<string, CacheNamespaceStats> = {};
    for (const [ns, store] of this.stores) out[ns] = store.stats;
    return out;
  }

  get fileStore(): FileStore { return this.inner.fileStore; }

  close(): Promise<void> { return this.inner.close?.() ?? Promise.resolve(); }
}
