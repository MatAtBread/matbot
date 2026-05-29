import type { Session, Store, FilterExpr } from '@matatbread/matbot-core';
import type { MemoryEntry, MemoryManager, RecallQuery, ContextBlock } from '@matatbread/matbot-memory-types';

export class MemoryManagerImpl implements MemoryManager {
  private readonly store: Store<MemoryEntry>;
  constructor(store: Store<MemoryEntry>) { this.store = store; }

  async recall(query: RecallQuery): Promise<MemoryEntry[]> {
    const filters: FilterExpr[] = [];

    if (query.contexts && query.contexts.length > 0) {
      // entries that share at least one context with the query
      filters.push({
        or: query.contexts.map(c => ({ field: 'contexts', op: 'contains' as const, value: c })),
      });
    }

    if (query.minConfidence !== undefined) {
      filters.push({ field: 'confidence', op: 'gte', value: query.minConfidence });
    }

    if (query.filter) {
      filters.push(query.filter);
    }

    const filter: FilterExpr | undefined =
      filters.length === 0 ? undefined :
      filters.length === 1 ? filters[0] :
      { and: filters };

    const result = await this.store.query({
      ...(filter              !== undefined ? { filter }                                                          : {}),
      ...(query.text          !== undefined ? { fullText: query.text }                                           : {}),
      ...(query.embedding     !== undefined ? { vector: { embedding: query.embedding, topK: query.limit ?? 20 } } : {}),
      limit: query.limit ?? 20,
      sort:  [{ field: 'lastReinforcedAt', direction: 'desc' }],
    });

    return result.items.map(i => i.doc);
  }

  async remember(entry: Omit<MemoryEntry, 'id' | 'version' | 'createdAt'>): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const doc: MemoryEntry = {
      ...entry,
      id:        crypto.randomUUID(),
      version:   crypto.randomUUID(),
      createdAt: now,
    };
    await this.store.set(doc.id, doc);
    return doc;
  }

  async reinforce(id: string, delta = 1): Promise<void> {
    // CAS retry loop
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await this.store.get(id);
      if (!current) return;

      const next: MemoryEntry = {
        ...current,
        version:          crypto.randomUUID(),
        recallCount:      current.recallCount + delta,
        lastReinforcedAt: new Date().toISOString(),
      };

      const result = await this.store.cas(id, current.version, next);
      if (result.ok) return;
    }
    throw new Error(`reinforce: CAS failed after retries for ${id}`);
  }

  async forget(id: string): Promise<void> {
    await this.store.delete(id);
  }

  async purge(ownerPrincipalId: string): Promise<number> {
    let deleted = 0;
    let offset  = 0;

    while (true) {
      const result = await this.store.query({
        filter: { field: 'ownerPrincipalId', op: 'eq', value: ownerPrincipalId },
        limit:  100,
        offset,
      });

      for (const { doc } of result.items) {
        await this.store.delete(doc.id);
        deleted++;
      }

      if (result.items.length < 100) break;
      offset += 100;
    }

    return deleted;
  }

  async buildContext(session: Session, _signal: AbortSignal): Promise<ContextBlock[]> {
    if (session.contexts.length === 0) return [];

    const entries = await this.recall({
      contexts:      session.contexts,
      limit:         10,
      minConfidence: 0.3,
    });

    if (entries.length === 0) return [];

    // Format each entry as a concise reference to where the fact lives
    const lines = entries.map(e =>
      `- [session:${e.sessionId} msg:${e.messageId}] (confidence ${e.confidence.toFixed(2)}, tags: ${e.tags.join(', ')})`
    );

    return [{
      role:      'system',
      content:   `Relevant memory references:\n${lines.join('\n')}`,
      sourceIds: entries.map(e => e.id),
    }];
  }
}
