import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeQuery } from '@matatbread/matbot-core/storage-base';
import { makeSessionTools } from '@matatbread/matbot-sessions';
import type { Session, Store, Tool, ToolContext } from '@matatbread/matbot-plugin-api';

// `limit: 0` is the count form of the query grammar: the filter runs, `total` answers, and nothing
// is materialised. Two things have to hold for it to be usable, and both are easy to lose:
//   - no cursor. A zero-length page never advances the offset, so a caller paging on one would
//     loop forever on the same empty slice.
//   - a total over EVERY match, not the page. session_action reimplements the grammar with an
//     early exit (it synthesizes conversation text per session, so it stops the moment the page is
//     full); counting is the one query that cannot early-exit, and the guard is easy to leave in.

const docs = Array.from({ length: 7 }, (_, i) => ({ id: String(i), version: 'v', flag: i % 2 === 0 }));

test('limit 0 counts every match, returns no items, and issues no cursor', () => {
  const res = executeQuery(docs, { where: { op: 'eq', field: 'flag', value: true }, limit: 0 });
  assert.deepEqual(res.items, []);
  assert.equal(res.total, 4);
  assert.equal(res.cursor, undefined);
});

test('limit 0 with no filter counts the whole store', () => {
  assert.equal(executeQuery(docs, { limit: 0 }).total, docs.length);
});

test('a non-zero limit still pages, so the count form is the only silent one', () => {
  const res = executeQuery(docs, { limit: 2 });
  assert.equal(res.items.length, 2);
  assert.equal(res.total, 7);
  assert.notEqual(res.cursor, undefined);
});

// ── session_action, which reimplements the grammar over synthesized text columns ────────────────

function session(id: string, text: string): Session {
  const now = new Date().toISOString();
  return {
    id, version: 'v', status: 'active', createdAt: now, updatedAt: now,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  } as Session;
}

function memoryStore(items: Session[]): Store<Session> {
  const map = new Map(items.map(s => [s.id, s]));
  return {
    async get(id)  { return map.get(id) ?? null; },
    async set(id, v) { map.set(id, v); },
    async cas(id, _e, next) { map.set(id, next); return { ok: true, doc: next }; },
    async delete(id) { return map.delete(id); },
    async query(q) { return executeQuery([...map.values()], q); },
  };
}

async function runTool(tool: Tool, input: unknown): Promise<unknown> {
  for await (const ev of tool.executor.execute(input, {} as ToolContext)) {
    if (ev.type === 'error')  throw new Error(ev.message);
    if (ev.type === 'result') return ev.value;
  }
  throw new Error('tool yielded no result');
}

const sessionsFixture = [
  session('a', 'the invoice is late'),
  session('b', 'nothing to see'),
  session('c', 'another INVOICE question'),
  session('d', 'invoice invoice invoice'),
];

test('session_action query with limit 0 counts all matches without reading past the page', async () => {
  const tool  = makeSessionTools(memoryStore(sessionsFixture)).find(t => t.name === 'session_action')!;
  const where = { op: 'stringContains', field: 'user', value: 'invoice' };

  const counted = await runTool(tool, { action: 'query', where, limit: 0 }) as { items: unknown[]; total?: number; cursor?: string };
  assert.deepEqual(counted.items, []);
  assert.equal(counted.total, 3);          // case-insensitive: 'INVOICE' counts
  assert.equal(counted.cursor, undefined);

  // The count must not be the page size — a limit of 1 still early-exits and reports no total.
  const paged = await runTool(tool, { action: 'query', where, limit: 1 }) as { items: unknown[]; total?: number };
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, undefined);
});
