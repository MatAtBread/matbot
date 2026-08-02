import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Store, StoreQuery, QueryResult, CASResult } from '@matatbread/matbot-plugin-api';
import { executeQuery } from '@matatbread/matbot-core/storage-base';

interface Parsed<T> { mtimeMs: number; size: number; doc: T }

// Cap on the source bytes held parsed. A store larger than this keeps the hottest documents and lets
// the rest fall back to a fresh read, rather than growing without bound.
const PARSE_CACHE_BYTES = 64 * 1024 * 1024;

export class FilesystemStore<T extends { id: string; version: string }> implements Store<T> {
  private initPromise: Promise<void> | undefined;
  private locks = new Map<string, Promise<unknown>>();

  /**
   * Parsed documents from previous `immutable` queries, keyed by file name. `Store` has no projection,
   * so a summary listing must read every document in the namespace whole: for `sessions` that is every
   * message of every conversation parsed to answer a question about four fields — 517ms for 52MB in one
   * real profile, on every sidebar refresh. The read is unavoidable; re-parsing what has not changed
   * is not.
   *
   * Validity is a fresh `stat` (mtime + size) on every query, never write-through invalidation — 3ms
   * for the same 213 files — so a document written by another process (a detached background job, an
   * editor) invalidates exactly like a local write, and a stale entry cannot outlive the stat that
   * disagrees with it. Writes through this store additionally drop their own entry, closing the window
   * where a rewrite of identical length within the same filesystem timestamp tick would look unchanged.
   *
   * Only `immutable` queries read or fill it, so a shared instance is never handed to a caller that
   * might edit it. Insertion order is the LRU order: a hit re-inserts.
   */
  private parsed = new Map<string, Parsed<T>>();
  private parsedBytes = 0;

  private readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

  private remember(name: string, entry: Parsed<T>): void {
    const prev = this.parsed.get(name);
    if (prev !== undefined) this.parsedBytes -= prev.size;
    this.parsed.set(name, entry);
    this.parsedBytes += entry.size;
    for (const [key, value] of this.parsed) {
      if (this.parsedBytes <= PARSE_CACHE_BYTES) break;
      if (key === name) continue;
      this.parsed.delete(key);
      this.parsedBytes -= value.size;
    }
  }

  private forget(id: string): void {
    const name = `${id}.json`;
    const prev = this.parsed.get(name);
    if (prev === undefined) return;
    this.parsed.delete(name);
    this.parsedBytes -= prev.size;
  }

  // ── Initialisation ───────────────────────────────────────────────────────────

  private init(): Promise<void> {
    return (this.initPromise ??= fs.mkdir(this.dir, { recursive: true }).then(() => undefined));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private safeName(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid store id: "${id}"`);
    return id;
  }

  private filePath(id: string): string {
    return join(this.dir, `${this.safeName(id)}.json`);
  }

  // Promise-chain mutex — serialises concurrent operations on the same key.
  // Safe within a single process; cross-process safety requires SQL/ES.
  private withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const tail = (this.locks.get(key) ?? Promise.resolve()).then(() => fn());
    this.locks.set(key, tail.then(() => undefined, () => undefined));
    return tail;
  }

  private async writeAtomic(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    try {
      await fs.rename(tmp, filePath);
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  // ── Store<T> implementation ───────────────────────────────────────────────────

  async get(id: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(id), 'utf8')) as T;
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
  }

  async set(id: string, value: T): Promise<void> {
    await this.init();
    await this.writeAtomic(this.filePath(id), JSON.stringify(value, null, 2));
    this.forget(id);
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    return this.withLock(id, async () => {
      const current = await this.get(id);
      if (current === null || current.version !== expected) {
        return { ok: false, current } satisfies CASResult<T>;
      }
      await this.set(id, next);
      return { ok: true, doc: next } satisfies CASResult<T>;
    });
  }

  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    return this.withLock(id, async () => {
      if (expectedVersion !== undefined) {
        const current = await this.get(id);
        if (current === null || current.version !== expectedVersion) return false;
      }
      try {
        await fs.unlink(this.filePath(id));
        this.forget(id);
        return true;
      } catch {
        return false;
      }
    });
  }

  async query(q: StoreQuery): Promise<QueryResult<T>> {
    await this.init();

    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return { items: [], total: 0 };
    }

    // Collect into a mutable array to avoid Awaited<T> inference from Promise.all
    const pool: T[] = [];
    await Promise.all(
      entries
        .filter(e => /^[\w-]+\.json$/.test(e))
        .map(async e => {
          const path = join(this.dir, e);
          try {
            if (q.immutable !== true) {
              pool.push(JSON.parse(await fs.readFile(path, 'utf8')) as T);
              return;
            }
            const stat = await fs.stat(path);
            const hit  = this.parsed.get(e);
            if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
              this.parsed.delete(e);          // re-insert: insertion order is the LRU order
              this.parsed.set(e, hit);
              pool.push(hit.doc);
              return;
            }
            const doc = JSON.parse(await fs.readFile(path, 'utf8')) as T;
            pool.push(doc);
            this.remember(e, { mtimeMs: stat.mtimeMs, size: stat.size, doc });
          } catch { /* skip corrupted, or vanished between readdir and read */ }
        }),
    );

    return executeQuery(pool, q);
  }
}
