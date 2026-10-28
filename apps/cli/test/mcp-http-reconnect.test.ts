import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { MatbotMachine, Tool } from '@matatbread/matbot-plugin-api';
import { createMcpHttpPlugin, RemoteMcpManager } from '../../../plugins/mcp-http/src/index.ts';

// `mcp-http` awaited every persisted server's reconnect inside setup(), one after another, with no bound
// on the handshake. An unroutable endpoint held the whole boot for ~21s; one that accepted the connection
// and never replied held it indefinitely — and every plugin listed after it with it.

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; close(): void }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer(handler);
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, close() { for (const s of sockets) s.destroy(); server.close(); } };
}

const silent = () => listen(() => { /* accepts, never answers */ });
const answering = () => listen((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const { id, method } = JSON.parse(body) as { id: number; method: string };
    const result = method === 'tools/list' ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } : {};
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});

function machine(endpoints: string[]) {
  const tools: Tool[] = [];
  const store = new Map<string, unknown>([['servers', { servers: endpoints.map((endpoint, i) => ({ type: 'remote', name: `s${i}`, endpoint })) }]]);
  const settings = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v); }, delete: async () => {} };
  const services = {
    settings: () => settings,
    register: async () => {},
    tools: { register: (t: Tool) => { tools.push(t); }, remove: () => {}, resolve: () => null, list: () => tools },
  } as unknown as MatbotMachine;
  return { services, settings, tools };
}

test('setup() does not wait for a persisted server that never answers', async t => {
  const hung = await silent();
  const plugin = createMcpHttpPlugin();
  t.after(async () => { await plugin.teardown?.(); hung.close(); });
  const { services } = machine([hung.url]);

  const started = performance.now();
  await plugin.setup!(services);
  assert.ok(performance.now() - started < 1000, 'setup returns without waiting for the handshake');
});

test('one silent server does not hold back another one\'s tools', async t => {
  const hung = await silent();
  const ok   = await answering();
  const { services, settings, tools } = machine([hung.url, ok.url]);
  const manager = new RemoteMcpManager(services, settings as never);
  t.after(() => { manager.closeAll(); hung.close(); ok.close(); });

  void manager.reconnectPersisted(() => {});
  const deadline = Date.now() + 2000;
  while (tools.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(tools.map(t => t.name), ['mcp__s1__ping'], 'the answering server connects while the other hangs');
});

test('closing mid-handshake ends it at once and registers nothing', async t => {
  const hung = await silent();
  const { services, settings, tools } = machine([hung.url]);
  const manager = new RemoteMcpManager(services, settings as never);
  t.after(() => hung.close());
  const errors: string[] = [];

  const reconnect = manager.reconnectPersisted(name => { errors.push(name); });
  await new Promise(r => setTimeout(r, 50));
  manager.closeAll();
  const started = performance.now();
  await reconnect;

  assert.ok(performance.now() - started < 500, 'the in-flight handshake is aborted, not waited out');
  assert.equal(tools.length, 0);
  assert.deepEqual(errors, [], 'a teardown is not reported as a failure to reconnect');
});
