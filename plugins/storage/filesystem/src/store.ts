import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Store, StoreQuery, QueryResult, CASResult } from '@matatbread/matbot-plugin-api';
import { executeQuery } from '@matatbread/matbot-core/storage-base';

export class FilesystemStore<T extends { id: string; version: string }> implements Store<T> {
  private initPromise: Promise<void> | undefined;
  private locks = new Map<string, Promise<unknown>>();

  private readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

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
          try {
            pool.push(JSON.parse(await fs.readFile(join(this.dir, e), 'utf8')) as T);
          } catch { /* skip corrupted */ }
        }),
    );

    return executeQuery(pool, q);
  }
}
