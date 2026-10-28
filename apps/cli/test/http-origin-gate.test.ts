import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PermissionDecision, PermissionRequest, Session, ToolContext, ToolEvent } from '@matatbread/matbot-core';
import { VaultImpl, createSession, permitted, refused } from '@matatbread/matbot-core';
import { httpTool } from '../../../plugins/http/src/index.ts';

// A request can carry whatever the conversation holds, so the `http` tool asks before it reaches an origin
// — and again for each origin a redirect leads to, which is otherwise a way past the first answer (#111).

async function serve(handler: (method: string, url: string, body: string) => { status?: number; headers?: Record<string, string>; body?: string }):
  Promise<{ origin: string; seen: { method: string; url: string; body: string }[]; close: () => Promise<void> }> {
  const seen: { method: string; url: string; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += String(c); });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      const r = handler(req.method ?? '', req.url ?? '', body);
      res.writeHead(r.status ?? 200, r.headers ?? {});
      res.end(r.body ?? 'ok');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise(r => server.close(() => r())) };
}

async function run(input: Record<string, unknown>, decide: (req: PermissionRequest) => PermissionDecision = () => permitted('user')):
  Promise<{ events: ToolEvent[]; asked: PermissionRequest[] }> {
  const asked: PermissionRequest[] = [];
  const ctx = {
    callId: 'c1', session: createSession() as Session, signal: new AbortController().signal, vault: new VaultImpl({}),
    gate: async (req: PermissionRequest) => { asked.push(req); return decide(req); },
  } as unknown as ToolContext;
  const events: ToolEvent[] = [];
  for await (const ev of httpTool.executor.execute(input, ctx)) events.push(ev);
  return { events, asked };
}

test('a request asks about its origin first, and a refusal sends nothing', async () => {
  const api = await serve(() => ({ body: 'fine' }));
  try {
    const allowed = await run({ url: `${api.origin}/a?b=c` });
    assert.deepEqual(allowed.events, [{ type: 'result', value: 'fine' }]);
    assert.deepEqual(allowed.asked.map(r => [r.gate, r.subject, r.fallback]), [['request', api.origin, false]]);
    assert.deepEqual(allowed.asked[0]?.standing?.map(s => s.subject), [api.origin]);

    const denied = await run({ url: api.origin }, () => refused('fallback'));
    assert.equal(denied.events.length, 1);
    assert.equal(denied.events[0]?.type, 'error');
    assert.match((denied.events[0] as { message: string }).message, new RegExp(`request to ${api.origin}`));
    assert.equal(api.seen.length, 1);
  } finally { await api.close(); }
});

test('a redirect to another origin is asked about, and not followed when refused', async () => {
  const elsewhere = await serve(() => ({ body: 'landed' }));
  const api = await serve(() => ({ status: 302, headers: { location: `${elsewhere.origin}/x` } }));
  try {
    const followed = await run({ url: api.origin });
    assert.deepEqual(followed.events, [{ type: 'result', value: 'landed' }]);
    assert.deepEqual(followed.asked.map(r => r.subject), [api.origin, elsewhere.origin]);

    const stopped = await run({ url: api.origin }, req => req.subject === api.origin ? permitted('user') : refused('user'));
    assert.equal(stopped.events[0]?.type, 'error');
    assert.equal(elsewhere.seen.length, 1);
  } finally { await api.close(); await elsewhere.close(); }
});

test('a same-origin redirect asks once; 303 turns a POST into a GET, 307 resends it', async () => {
  const api = await serve((method, url, body) =>
    url === '/see' ? { status: 303, headers: { location: '/done' } }
  : url === '/keep' ? { status: 307, headers: { location: '/done' } }
  : { body: `${method} ${body}` });
  try {
    const see = await run({ url: `${api.origin}/see`, method: 'POST', body: 'payload' });
    assert.deepEqual(see.events, [{ type: 'result', value: 'GET ' }]);
    assert.equal(see.asked.length, 1);
    const keep = await run({ url: `${api.origin}/keep`, method: 'POST', body: 'payload' });
    assert.deepEqual(keep.events, [{ type: 'result', value: 'POST payload' }]);
  } finally { await api.close(); }
});

test('the origin is exact: another port is another question', async () => {
  const a = await serve(() => ({}));
  const b = await serve(() => ({}));
  try {
    const seen = new Set<string>();
    for (const o of [a.origin, b.origin, a.origin]) for (const r of (await run({ url: o })).asked) seen.add(r.subject);
    assert.deepEqual([...seen], [a.origin, b.origin]);
  } finally { await a.close(); await b.close(); }
});

test('a data: URL reaches no network and asks nothing', async () => {
  const { events, asked } = await run({ url: 'data:text/plain,hi' });
  assert.deepEqual(events, [{ type: 'result', value: 'hi' }]);
  assert.equal(asked.length, 0);
});
