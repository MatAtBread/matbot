import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, installPrincipalCarrier, installUsageCarrier, createNotifier } from '@matatbread/matbot-core';
import type { Session, Store, ToolRegistry, Vault } from '@matatbread/matbot-core';
import { createWebServer } from '../../../plugins/frontend/web/src/server.js';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// `POST /sessions` may name the new session's status, so a session can be created hidden (archived)
// rather than created visible and hidden by a second write — which every client watching the session
// list would see appear and vanish. No body is the original form and still means a plain active one.

async function withServer(fn: (base: string, docs: Map<string, Session>) => Promise<void>): Promise<void> {
  const docs = new Map<string, Session>();
  const store = {
    get:    async (id: string) => docs.get(id) ?? null,
    set:    async (id: string, v: Session) => { docs.set(id, v); },
    cas:    async () => { throw new Error('cas unused'); },
    delete: async (id: string) => { docs.delete(id); },
  } as unknown as Store<Session>;
  const tools = {
    register: () => {}, unregister: () => {}, resolve: () => null, list: () => [], has: () => false,
  } as unknown as ToolRegistry;
  const run = createSessionRunner({
    store, resolveProvider: async () => null, tools,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  const web = createWebServer({
    store, run, notifier: createNotifier(), tools,
    vault: { resolve: async (v: string) => v } as unknown as Vault,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  await new Promise<void>(r => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as { port: number }).port}`;
  try { await fn(base, docs); } finally { web.server.close(); }
}

const create = (base: string, body?: unknown) => fetch(`${base}/sessions`, body === undefined ? { method: 'POST' } : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('POST /sessions with no body creates an active session', { timeout: 20000 }, async () => {
  await withServer(async (base, docs) => {
    const res = await create(base);
    assert.equal(res.status, 201);
    const { id } = await res.json() as { id: string };
    assert.equal(docs.get(id)?.status, 'active');
  });
});

test('POST /sessions with status "archived" creates it hidden', { timeout: 20000 }, async () => {
  await withServer(async (base, docs) => {
    const res = await create(base, { status: 'archived' });
    assert.equal(res.status, 201);
    const { id } = await res.json() as { id: string };
    assert.equal(docs.get(id)?.status, 'archived');
  });
});

test('POST /sessions refuses a status that is not one', { timeout: 20000 }, async () => {
  await withServer(async (base, docs) => {
    const res = await create(base, { status: 'hidden' });
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /"status" must be/);
    assert.equal(docs.size, 0, 'nothing is created on a refusal');
  });
});
