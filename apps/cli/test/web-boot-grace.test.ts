import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, createNotifier,
  RegistryChangeKind,
} from '@matatbread/matbot-core';
import type { Session, Store, Tool, ToolRegistry, Vault, Notifier } from '@matatbread/matbot-core';
import { createWebServer } from '../../../plugins/frontend/web/src/server.js';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// The /tools endpoints hold a name that hasn't registered yet, because the server starts listening inside
// frontend-web's setup() — before the plugins configured after it, and before core's own tools. Without
// that, a browser already open when the server restarts 404s tools that are merely late.
//
// The wait used to end on a CLOCK: 30s from server construction, whatever the registry was doing. So a
// name that would NEVER register — the UI probing `profile_action` on an install with no profiles backend
// — parked for the whole remaining window before 404ing, long after every plugin had loaded. The registry
// going quiet is the signal that was missing.

const principal = { id: 'tester', type: 'user' as const };

function boot(tools: Tool[]) {
  const session = createSession();
  const docs = new Map<string, Session>([[session.id, session]]);
  const store = {
    get:    async (id: string) => docs.get(id) ?? null,
    set:    async (id: string, v: Session) => { docs.set(id, v); },
    cas:    async (id: string, _v: string, next: Session) => { docs.set(id, next); return next; },
    delete: async (id: string) => { docs.delete(id); },
  } as unknown as Store<Session>;
  const registry = {
    register: () => {}, unregister: () => {},
    resolve: (n: string) => tools.find(t => t.name === n) ?? null,
    list: () => tools, has: (n: string) => tools.some(t => t.name === n),
  } as unknown as ToolRegistry;
  const notifier = createNotifier();
  const run = createSessionRunner({
    store, resolveProvider: async () => null, tools: registry,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  const web = createWebServer({
    store, run, notifier, tools: registry,
    vault: { resolve: async (v: string) => v } as unknown as Vault,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  return { web, notifier, registry, store, run };
}

/** A plugin's setup() registering a tool, as the registry announces it. */
function announce(notifier: Notifier, name: string): void {
  notifier.notify({
    kind: RegistryChangeKind, registry: 'tools', name, operation: 'added',
    source: 'test', principal,
  } as Parameters<Notifier['notify']>[0]);
}

async function serve(tools: Tool[]) {
  const b = boot(tools);
  await new Promise<void>(r => b.web.server.listen(0, '127.0.0.1', r));
  return { ...b, base: `http://127.0.0.1:${(b.web.server.address() as { port: number }).port}` };
}

test('GET /ui-config reports the heartbeat the client has to reason about', { timeout: 20000 }, async () => {
  // The client's idle deadline is only meaningful relative to how often this server speaks, and it used to
  // hardcode a number that had to match this one by hand. Serving the fact makes the coupling data.
  const b = boot([]);
  b.web.server.close();
  const web = createWebServer({
    store: b.store, run: b.run, notifier: b.notifier, tools: b.registry, heartbeatMs: 1234,
    vault: { resolve: async (v: string) => v } as unknown as Vault,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  await new Promise<void>(r => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as { port: number }).port}`;
  try {
    const cfg = await (await fetch(`${base}/ui-config`)).json() as { heartbeatMs?: number };
    assert.equal(cfg.heartbeatMs, 1234);
  } finally { await web.close(); }
});

const echo: Tool = {
  name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: {} },
  executor: { async *execute() { yield { type: 'result', value: 'ok' }; } },
};

test('a tool that will never register 404s once the registry settles', { timeout: 30000 }, async () => {
  const { base, web } = await serve([echo]);
  try {
    // The registry has been quiet since construction, so the settle deadline is already the near one —
    // NOT the 30s ceiling. This is the UI probing for an optional capability that is not installed.
    const started = Date.now();
    const res = await fetch(`${base}/tools/profile_action`, { method: 'POST', body: JSON.stringify({ action: 'list' }) });
    const waited = Date.now() - started;
    assert.equal(res.status, 404);
    assert.ok(waited < 5_000, `should give up when the registry settles, not at the ceiling — waited ${waited}ms`);
  } finally { await web.close(); }
});

test('a tool that is merely late is still waited for', { timeout: 30000 }, async () => {
  const tools: Tool[] = [];
  const { base, web, notifier } = await serve(tools);
  try {
    const pending = fetch(`${base}/tools/echo`, { method: 'POST', body: JSON.stringify({}) });
    // A plugin's setup() lands after the request — the whole reason the grace exists.
    await new Promise(r => setTimeout(r, 300));
    tools.push(echo);
    announce(notifier, 'echo');
    const res = await pending;
    assert.equal(res.status, 200, 'a late tool must not 404');
  } finally { await web.close(); }
});

test('registry churn keeps the grace alive for an unknown name', { timeout: 30000 }, async () => {
  const { base, web, notifier } = await serve([echo]);
  try {
    const started = Date.now();
    const pending = fetch(`${base}/tools/never_exists`, { method: 'POST', body: JSON.stringify({}) });
    // Boot is still registering things — the deadline must keep moving out while it does, or a slow boot
    // would 404 a tool that had not had its turn yet.
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 700));
      announce(notifier, `other_tool_${i}`);
    }
    const res = await pending;
    const waited = Date.now() - started;
    assert.equal(res.status, 404);
    assert.ok(waited > 3_000, `churn should have deferred the give-up — waited only ${waited}ms`);
    assert.ok(waited < 20_000, `but it must still settle well inside the ceiling — waited ${waited}ms`);
  } finally { await web.close(); }
});
