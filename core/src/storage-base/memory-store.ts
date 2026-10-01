import type { Store, CASResult, StoreQuery, QueryResult } from '@matatbread/matbot-plugin-api';
import { executeQuery } from './query/index.js';

/** A `Store` held in a `Map`: nothing persists, nothing is announced, nothing outlives the instance. */
export class MemoryStore<T extends { id: string; version: string }> implements Store<T> {
  private readonly items = new Map<string, T>();

  async get(id: string): Promise<T | null> {
    return this.items.get(id) ?? null;
  }

  async set(id: string, value: T): Promise<void> {
    this.items.set(id, value);
  }

  async cas(id: string, expected: string, next: T): Promise<CASResult<T>> {
    const current = this.items.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.items.set(id, next);
    return { ok: true, doc: next };
  }

  async delete(id: string, expectedVersion?: string): Promise<boolean> {
    if (expectedVersion !== undefined) {
      const current = this.items.get(id);
      if (current === undefined || current.version !== expectedVersion) return false;
    }
    return this.items.delete(id);
  }

  async query(q: StoreQuery): Promise<QueryResult<T>> {
    return executeQuery([...this.items.values()], q);
  }
}
