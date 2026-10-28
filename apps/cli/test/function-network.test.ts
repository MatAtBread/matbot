import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { stripTypeScriptTypes } from 'node:module';
import { buildAsyncFn, runFunction, type CompileHost } from '@matatbread/matbot-function-tools';
import type { MatbotMachine, PermissionRequest, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { permitted, refused } from '@matatbread/matbot-core';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

// A body that can reach the network can send anything it has read to anywhere, so its `fetch` and
// `WebSocket` ask about each origin, as its `import(…)` asks about each module (#111). function-tools owns
// the gate and hands the pair to the runner per call; the runner binds them in place of the globals.

const runner = createVmFunctionRunner(2000);
const host: CompileHost = { TypeScriptStripper: { strip: (s: string) => stripTypeScriptTypes(s) }, FunctionRunner: runner };
const machine = {
  tools: { list: () => [] as Tool[], resolve: () => null, register: () => {}, remove: () => false },
  FunctionRunner: runner,
} as unknown as MatbotMachine;

async function serve(handler: (url: string) => { status?: number; headers?: Record<string, string>; body?: string } = () => ({})):
  Promise<{ origin: string; seen: { url: string; upgrade: string | undefined }[]; close: () => Promise<void> }> {
  const seen: { url: string; upgrade: string | undefined }[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', upgrade: req.headers.upgrade });
    const r = handler(req.url ?? '');
    res.writeHead(r.status ?? 200, r.headers ?? {});
    res.end(r.body ?? 'ok');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }) };
}

async function run(def: string, allow: (req: PermissionRequest) => boolean = () => true):
  Promise<{ final: ToolEvent | undefined; asked: (PermissionRequest & { namespace?: string })[] }> {
  const asked: (PermissionRequest & { namespace?: string })[] = [];
  const ctx = {
    callId: 'c1', session: { id: 's1' }, signal: new AbortController().signal,
    prompt: () => Promise.reject(new Error('non-interactive')),
    // The version half of `probe@<digest>` is function-imports' to pin; here only the origin matters.
    gate: (req: PermissionRequest & { namespace?: string }) => {
      const subject = req.subject.replace(/^probe@[0-9a-f]{32} /, 'probe ');
      const seen = { ...req, subject, ...(req.standing !== undefined ? { standing: req.standing.map(o => ({ ...o, subject: o.subject.replace(/^probe@[0-9a-f]{32} /, 'probe ') })) } : {}) };
      asked.push(seen); return Promise.resolve(allow(seen) ? permitted('user') : refused('user'));
    },
  } as unknown as ToolContext;
  const fn = await buildAsyncFn(host, def, []);
  let final: ToolEvent | undefined;
  for await (const ev of runFunction(machine, ctx, fn, [], { tool: 'probe', source: def })) final = ev;
  return { final, asked };
}

test("a body's fetch asks about the origin, once per invocation, named for the function", async () => {
  const api = await serve(() => ({ body: 'pong' }));
  try {
    const { final, asked } = await run(`probe() { return Promise.all([fetch('${api.origin}/a'), fetch('${api.origin}/b')]).then(rs => Promise.all(rs.map(r => r.text()))); }`);
    assert.deepEqual(final, { type: 'result', value: ['pong', 'pong'] });
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0]?.namespace, asked[0]?.gate, asked[0]?.subject, asked[0]?.fallback], ['tool_function', 'connect', `probe ${api.origin}`, false]);
    assert.deepEqual(asked[0]?.standing?.map(s => s.subject), [`probe ${api.origin}`, `* ${api.origin}`]);
  } finally { await api.close(); }
});

test('a refused origin is never reached, and the body sees why', async () => {
  const api = await serve();
  try {
    const { final } = await run(`probe() { return fetch('${api.origin}').then(() => 'sent', e => String(e.message)); }`, () => false);
    assert.equal(final?.type, 'result');
    assert.match(String((final as { value: unknown }).value), new RegExp(`Connecting to ${api.origin}`));
    assert.equal(api.seen.length, 0);
  } finally { await api.close(); }
});

test('a redirect to another origin is a new question', async () => {
  const elsewhere = await serve(() => ({ body: 'there' }));
  const api = await serve(() => ({ status: 302, headers: { location: `${elsewhere.origin}/x` } }));
  try {
    const { final, asked } = await run(`probe() { return fetch('${api.origin}').then(r => r.text(), e => 'refused'); }`,
                                       req => req.subject === `probe ${api.origin}`);
    assert.deepEqual(final, { type: 'result', value: 'refused' });
    assert.deepEqual(asked.map(r => r.subject), [`probe ${api.origin}`, `probe ${elsewhere.origin}`]);
    assert.equal(elsewhere.seen.length, 0);
  } finally { await api.close(); await elsewhere.close(); }
});

test('a WebSocket waits for the gate: refused, it fails with the reason and never connects', async () => {
  const api = await serve();
  const ws = api.origin.replace('http:', 'ws:');
  const body = `probe() { return new Promise(done => { const s = new WebSocket('${ws}'); const state = s.readyState;
    s.onclose = (e) => done({ state, code: e.code, reason: e.reason }); }); }`;
  try {
    const { final, asked } = await run(body, () => false);
    const value = (final as { value: { state: number; code: number; reason: string } }).value;
    assert.deepEqual([value.state, value.code], [0, 1006]);
    assert.match(value.reason, new RegExp(`Connecting to ${ws}`));
    assert.deepEqual(asked.map(r => r.subject), [`probe ${ws}`]);
    assert.equal(api.seen.length, 0);

    // Allowed, it does connect: this server refuses the upgrade, which is the real socket's own failure.
    const allowed = await run(body);
    assert.equal((allowed.final as { value: { code: number } }).value.code, 1006);
    assert.equal(api.seen[0]?.upgrade, 'websocket');
  } finally { await api.close(); }
});
