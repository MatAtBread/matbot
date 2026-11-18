import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, createNotifier,
} from '@matatbread/matbot-core';
import type { Session, Store, Tool, ToolRegistry, Vault, ToolEvent, ToolContext } from '@matatbread/matbot-core';
import { createWebServer } from '../../../plugins/frontend/web/src/server.js';
import { createAlsPrincipalCarrier } from '@matatbread/matbot-host-node';
import { createAlsUsageCarrier } from '@matatbread/matbot-host-node';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// A caller that goes away must abort the tool it called: `ctx.signal` is how a tool learns nobody is
// waiting, and a query tool hands it on to the database so the work is cancelled rather than finished
// for no one.
//
// Both tool doors listened on `req.on('close')`, attached AFTER the body was read. Since Node 16 an
// IncomingMessage closes once its body has been consumed, not when the client disconnects, so on a
// disconnect that listener never ran and the tool's signal never aborted. A query a closed dashboard had
// started kept its place in the runner's per-user queue and then ran to completion. The response's
// `close` is the one that means "the connection went away" — and it also fires after a normal reply,
// which is why the abort is guarded on the response not having been sent.

function serveTool(tool: Tool) {
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
    resolve: (n: string) => (n === tool.name ? tool : null),
    list: () => [tool], has: (n: string) => n === tool.name,
  } as unknown as ToolRegistry;
  const notifier = createNotifier();
  const run = createSessionRunner({
    store, resolveProvider: async () => null, tools: registry,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  return createWebServer({
    store, run, notifier, tools: registry,
    vault: { resolve: async (v: string) => v } as unknown as Vault,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
}

async function withServer(tool: Tool, fn: (base: string) => Promise<void>): Promise<void> {
  const web = serveTool(tool);
  await new Promise<void>(r => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as { port: number }).port}`;
  try { await fn(base); } finally { web.server.close(); web.server.closeAllConnections?.(); }
}

/** A tool that runs until its caller's signal aborts (or 5s pass), and reports which happened. */
function waitingTool() {
  let started!: () => void;
  const running = new Promise<void>(r => { started = r; });
  let finish!: (how: 'aborted' | 'timed out') => void;
  const outcome = new Promise<'aborted' | 'timed out'>(r => { finish = r; });
  const tool: Tool = {
    name: 'slow_tool', description: 'waits for its caller', inputSchema: { type: 'object' },
    executor: {
      execute(_input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        return (async function* () {
          started();
          const how = await new Promise<'aborted' | 'timed out'>(resolve => {
            if (ctx.signal.aborted) return resolve('aborted');
            const timer = setTimeout(() => resolve('timed out'), 5000);
            ctx.signal.addEventListener('abort', () => { clearTimeout(timer); resolve('aborted'); }, { once: true });
          });
          finish(how);
          yield { type: 'result', value: { how } } as ToolEvent;
        })();
      },
    },
  };
  return { tool, running, outcome };
}

for (const door of ['/tools/slow_tool', '/stream/tools/slow_tool']) {
  test(`a caller disconnecting from POST ${door} aborts the tool's signal`, { timeout: 20000 }, async () => {
    const { tool, running, outcome } = waitingTool();
    await withServer(tool, async base => {
      const ac = new AbortController();
      const req = fetch(`${base}${door}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: ac.signal,
      }).then(res => res.text()).catch(() => undefined);
      await running;
      ac.abort();
      await req;
      assert.equal(await outcome, 'aborted', 'the tool must learn its caller has gone');
    });
  });
}

test('a request answered normally does not abort its tool afterwards', { timeout: 20000 }, async () => {
  // The response closes after every reply, not just a disconnect. A tool that left work tied to its
  // signal (a stream it is still draining, a cleanup listener) must not be told it was cancelled when it
  // in fact succeeded.
  let seen: AbortSignal | undefined;
  const tool: Tool = {
    name: 'quick_tool', description: 'answers at once', inputSchema: { type: 'object' },
    executor: {
      execute(_input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        seen = ctx.signal;
        return (async function* () { yield { type: 'result', value: { ok: true } } as ToolEvent; })();
      },
    },
  };
  await withServer(tool, async base => {
    const res = await fetch(`${base}/tools/quick_tool`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 200, await res.text());
    await new Promise(r => setTimeout(r, 200));
    assert.ok(seen, 'the tool ran');
    assert.equal(seen.aborted, false, 'a completed request is not a cancelled one');
  });
});
