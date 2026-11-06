import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSessionRunner, installPrincipalCarrier, installUsageCarrier, createNotifier } from '@matatbread/matbot-core';
import type { Session, Store, ToolRegistry, Vault } from '@matatbread/matbot-core';
import { createWebServer } from '../../../plugins/frontend/web/src/server.js';
import { createAlsPrincipalCarrier } from '@matatbread/matbot-host-node';
import { createAlsUsageCarrier } from '@matatbread/matbot-host-node';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// The model reaches the network from inside matbot's process, so a server refusing that process's own
// connections keeps it from answering the prompts the UI exists to put to a human. Another process — the
// browser, here a child node — is unaffected.

async function withServer(refuseOwnProcess: boolean, fn: (base: string) => Promise<void>): Promise<void> {
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
    store, run, notifier: createNotifier(), tools, refuseOwnProcess,
    vault: { resolve: async (v: string) => v } as unknown as Vault,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  await new Promise<void>(r => web.server.listen(0, '0.0.0.0', r));
  const base = `http://127.0.0.1:${(web.server.address() as { port: number }).port}`;
  try { await fn(base); } finally { await web.close(); }
}

const fromChild = async (url: string): Promise<number> => {
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', `fetch(${JSON.stringify(url)}).then(r => console.log(r.status))`]);
  return Number(stdout.trim());
};

test('a request from this process is refused', { timeout: 20000 }, async () => {
  await withServer(true, async (base) => {
    assert.equal((await fetch(`${base}/ui-config`)).status, 403);
    const post = await fetch(`${base}/sessions/x/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 403);
    assert.equal((await fetch(`${base.replace('127.0.0.1', 'localhost')}/ui-config`)).status, 403);
  });
});

test('another process is served', { timeout: 20000 }, async () => {
  await withServer(true, async (base) => {
    assert.equal(await fromChild(`${base}/ui-config`), 200);
  });
});

test('off unless asked', { timeout: 20000 }, async () => {
  await withServer(false, async (base) => {
    assert.equal((await fetch(`${base}/ui-config`)).status, 200);
  });
});
