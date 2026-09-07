import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, createNotifier,
  TOOL_INPUT_INVALID,
} from '@matatbread/matbot-core';
import type { Session, Store, Tool, ToolRegistry, Vault, ToolEvent } from '@matatbread/matbot-core';
import { createWebServer } from '../../../plugins/frontend/web/src/server.js';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// `POST /tools/:name` with no body used to hand the executor `null`, which nothing noticed until the
// input was actually validated: the UI calls `about_matbot` with no arguments, and `null` is not an
// object, so a params type of `NoParams` correctly refused it — HTTP 422 on page load.
//
// An absent body means "no arguments", which is an empty object. The proof that `{}` is the intended
// value and `null` was a slip: this same server passes `{}` when it calls `about_matbot` itself for the
// version header, the model's path always sends an object, and every tool reads its params as one.
//
// The fixture tool is deliberately NOT called `about_matbot`: the server probes that name itself on
// construction (with `{}`), which would land in the same recorder and race with the request.

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
  const web = createWebServer({
    store, run, notifier, tools: registry,
    vault: { resolve: async (v: string) => v } as unknown as Vault,
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  return web;
}

function echoTool(): { tool: Tool; seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    tool: {
      name: 'echo_tool', description: 'echoes its input', inputSchema: { type: 'object' },
      executor: {
        execute(input: unknown): AsyncIterable<ToolEvent> {
          seen.push(input);
          return (async function* () { yield { type: 'result', value: { ok: true } } as ToolEvent; })();
        },
      },
    },
  };
}

async function withServer(tool: Tool, fn: (base: string) => Promise<void>): Promise<void> {
  const web = serveTool(tool);
  await new Promise<void>(r => web.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(web.server.address() as { port: number }).port}`;
  try { await fn(base); } finally { web.server.close(); }
}

test('a tool POSTed with no body receives {}, not null', { timeout: 20000 }, async () => {
  const { tool, seen } = echoTool();
  await withServer(tool, async base => {
    // Exactly what the UI does for a no-argument tool: content-type set, body omitted.
    const res = await fetch(`${base}/tools/echo_tool`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(seen, [{}], 'the executor must see an empty object');
  });
});

test('an explicitly posted null is still null — the fix is narrow', { timeout: 20000 }, async () => {
  // Only the ABSENT body changes meaning. A client that says `null` said something, and a validator is
  // entitled to refuse it; silently rewriting it would hide a real client bug.
  const { tool, seen } = echoTool();
  await withServer(tool, async base => {
    const res = await fetch(`${base}/tools/echo_tool`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [null], 'an explicit null must reach the executor unchanged');
  });
});

test('a 4xx code from the executor becomes that HTTP status, not 500', { timeout: 20000 }, async () => {
  // How a rejected input surfaces over HTTP: core's validating wrapper yields an error event carrying
  // TOOL_INPUT_INVALID, and the route answers with it. 500 would have called a client error a server one.
  const tool: Tool = {
    name: 'echo_tool', description: 'always refuses', inputSchema: { type: 'object' },
    executor: {
      execute(): AsyncIterable<ToolEvent> {
        return (async function* () {
          yield { type: 'error', message: 'Invalid input for tool "echo_tool": .: expected object, got null', code: TOOL_INPUT_INVALID } as ToolEvent;
        })();
      },
    },
  };
  await withServer(tool, async base => {
    const res = await fetch(`${base}/tools/echo_tool`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, TOOL_INPUT_INVALID);
    const body = await res.json() as { error?: string; code?: number };
    assert.match(body.error ?? '', /expected object, got null/, 'the validator message must reach the caller');
    assert.equal(body.code, TOOL_INPUT_INVALID);
  });
});

test('a plain error still returns 500', { timeout: 20000 }, async () => {
  // The status mapping must not swallow genuine failures: only 400-499 is a client error, and a process
  // exit code (0-255) can never land there, so `bash` and friends keep reporting 500.
  const tool: Tool = {
    name: 'echo_tool', description: 'fails', inputSchema: { type: 'object' },
    executor: {
      execute(): AsyncIterable<ToolEvent> {
        return (async function* () { yield { type: 'error', message: 'boom', code: 127 } as ToolEvent; })();
      },
    },
  };
  await withServer(tool, async base => {
    const res = await fetch(`${base}/tools/echo_tool`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 500, 'an exit code is not an HTTP status');
  });
});
