import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, installPrincipalCarrier, installUsageCarrier, createNotifier } from '@matatbread/matbot-core';
import type { Session, Store, ToolRegistry, Vault } from '@matatbread/matbot-core';
import { createWebServer } from '../../../plugins/frontend/web/src/server.js';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// A page on another origin must not be able to drive this server. Same-origin is the default, and a POST
// that a browser would send without a preflight (anything not declared JSON) is refused before it is read.

async function withServer(cors: string | undefined, fn: (base: string, docs: Map<string, Session>) => Promise<void>): Promise<void> {
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
    ...(cors !== undefined ? { cors } : {}),
  });
  await new Promise<void>(r => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as { port: number }).port}`;
  try { await fn(base, docs); } finally { web.server.close(); }
}

test('no CORS grant by default', { timeout: 20000 }, async () => {
  await withServer(undefined, async (base) => {
    const res = await fetch(`${base}/sessions`, { headers: { origin: 'http://elsewhere.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(`${base}/tools/x`, { method: 'OPTIONS', headers: { origin: 'http://elsewhere.example' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
  });
});

test('a configured origin is granted', { timeout: 20000 }, async () => {
  await withServer('http://dash.example', async (base) => {
    const res = await fetch(`${base}/sessions`);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://dash.example');
  });
});

test('a POST not declared JSON is refused unread', { timeout: 20000 }, async () => {
  await withServer(undefined, async (base, docs) => {
    for (const init of [
      { method: 'POST', body: '{}' },                                                    // text/plain, as fetch sends a string
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' },
      { method: 'POST' },                                                                // no body, no type
    ]) {
      const res = await fetch(`${base}/sessions`, init);
      assert.equal(res.status, 415);
    }
    assert.equal(docs.size, 0);
    const ok = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' });
    assert.equal(ok.status, 201);
  });
});
