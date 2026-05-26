import type { AuditEvent, AuditLog, FilterExpr, Store } from '@matbot/core';

export class AuditLogImpl implements AuditLog {
  private readonly store: Store<AuditEvent>;
  constructor(store: Store<AuditEvent>) { this.store = store; }

  async append(event: Omit<AuditEvent, 'id' | 'version'>): Promise<void> {
    const doc: AuditEvent = { ...event, id: crypto.randomUUID(), version: crypto.randomUUID() } as AuditEvent;
    await this.store.set(doc.id, doc);
  }

  async *query(filter: FilterExpr, limit = 100): AsyncIterable<AuditEvent> {
    const result = await this.store.query({
      filter,
      limit,
      sort: [{ field: 'at', direction: 'desc' }],
    });
    for (const { doc } of result.items) {
      yield doc;
    }
  }
}
