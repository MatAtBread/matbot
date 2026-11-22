import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { MatbotMachine, PermissionDecision, PermissionRequest, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-core';
import { VaultImpl, createSession, permitted, refused } from '@matatbread/matbot-core';
import { createMcpHttpPlugin, RemoteMcpManager } from '../../../plugins/mcp-http/src/index.ts';

// A remote MCP server's header may name a vault key, in the `http` tool's grammar, so a keyed server needs
// no secret in the conversation or in the saved config. Pinned here: the key is asked about once, at `add`,
// as `<origin> <key>`; what persists is the `{ Vault }` form; the value is read per request; and it is
// redacted from what comes back, and never sent on through a redirect.

const SECRET = 'as_sk_test0123456789';

interface Server_ { url: string; origin: string; seen: IncomingHttpHeaders[]; close(): void }

async function serve(reply: (method: string, headers: IncomingHttpHeaders) => { status?: number; headers?: Record<string, string>; result?: unknown; raw?: string }): Promise<Server_> {
  const seen: IncomingHttpHeaders[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push(req.headers);
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const r = reply(method, req.headers);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
      res.end(r.raw ?? JSON.stringify({ jsonrpc: '2.0', id, result: r.result ?? {} }));
    });
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return { url: `${origin}/mcp`, origin, seen, close() { for (const s of sockets) s.destroy(); server.close(); } };
}

const keyed = () => serve((method, headers) => {
  if (headers.authorization !== `Bearer ${SECRET}`) return { result: { content: [{ type: 'text', text: 'no key' }] } };
  if (method === 'tools/list') return { result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } };
  if (method === 'tools/call') return { result: { content: [{ type: 'text', text: `results (you sent ${SECRET})` }] } };
  return {};
});

function machine(vault: Record<string, string>) {
  const tools: Tool[] = [];
  const store = new Map<string, unknown>();
  const settings = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); }, delete: async () => {} };
  const services = {
    settings: () => settings,
    register: async () => {},
    Vault: new VaultImpl(vault),
    tools: { register: (t: Tool) => { tools.push(t); }, remove: () => {}, resolve: () => null, list: () => tools },
  } as unknown as MatbotMachine;
  return { services, settings, store, tools };
}

async function add(services: MatbotMachine, input: Record<string, unknown>, decide: (req: PermissionRequest) => PermissionDecision = () => permitted('user')):
  Promise<{ events: ToolEvent[]; asked: PermissionRequest[]; plugin: ReturnType<typeof createMcpHttpPlugin> }> {
  const plugin = createMcpHttpPlugin();
  await plugin.setup!(services);
  const tool = (services.tools.list() as Tool[]).find(t => t.name === 'mcp_action')!;
  const asked: PermissionRequest[] = [];
  const ctx = {
    callId: 'c1', session: createSession(), signal: new AbortController().signal, vault: services.Vault,
    gate: async (req: PermissionRequest) => { if (req.gate === 'add') return permitted('user'); asked.push(req); return decide(req); },
  } as unknown as ToolContext;
  const events: ToolEvent[] = [];
  for await (const ev of tool.executor.execute({ action: 'add', type: 'remote', name: 'acme', ...input }, ctx)) events.push(ev);
  return { events, asked, plugin };
}

const resultOf = (events: ToolEvent[]): unknown => (events.find(e => e.type === 'result') as { value: unknown } | undefined)?.value;
const errorOf = (events: ToolEvent[]): string => (events.find(e => e.type === 'error') as { message: string } | undefined)?.message ?? '';

test('a { Vault } header is asked about at add as <origin> <key>, sent resolved, and saved unresolved', async t => {
  const api = await keyed();
  const { services, store, tools } = machine({ ACME_KEY: SECRET });
  const { events, asked, plugin } = await add(services, {
    endpoint: api.url, headers: { Authorization: { Vault: 'Bearer ${ACME_KEY}' }, 'X-Client': 'mcp/1.0.0' },
  });
  t.after(async () => { await plugin.teardown?.(); api.close(); });

  assert.deepEqual((resultOf(events) as { tools: string[] }).tools, ['mcp__acme__search'], JSON.stringify(events));
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.gate, 'secret');
  assert.equal(asked[0]?.subject, `${api.origin} ACME_KEY`);
  assert.ok(!JSON.stringify(asked).includes(SECRET), 'the gate is handed names, never the value');

  assert.ok(api.seen.every(h => h.authorization === `Bearer ${SECRET}` && h['x-client'] === 'mcp/1.0.0'));
  const saved = JSON.stringify(store.get('servers'));
  assert.ok(!saved.includes(SECRET), 'the resolved value is never persisted');
  assert.ok(saved.includes('"Vault":"Bearer ${ACME_KEY}"'));

  // A value the server echoes back is redacted from what the model reads.
  const search = tools.find(x => x.name === 'mcp__acme__search')!;
  const out: ToolEvent[] = [];
  for await (const ev of search.executor.execute({}, { signal: new AbortController().signal } as unknown as ToolContext)) out.push(ev);
  const text = JSON.stringify(out);
  assert.ok(text.includes('results (you sent [REDACTED])'), text);
  assert.ok(!text.includes(SECRET));
});

test('a refused key connects nothing and saves nothing', async t => {
  const api = await keyed();
  const { services, store, tools } = machine({ ACME_KEY: SECRET });
  const { events, plugin } = await add(services, { endpoint: api.url, headers: { Authorization: { Vault: 'Bearer ${ACME_KEY}' } } }, () => refused('user'));
  t.after(async () => { await plugin.teardown?.(); api.close(); });

  assert.match(errorOf(events), /ACME_KEY/);
  assert.equal(api.seen.length, 0, 'nothing was sent to the server');
  assert.equal(store.get('servers'), undefined);
  assert.equal(tools.filter(x => x.name.startsWith('mcp__')).length, 0);
});

test('a malformed { Vault } value is refused before anything is asked', async t => {
  const api = await keyed();
  const { services } = machine({ ACME_KEY: SECRET });
  const { events, asked, plugin } = await add(services, { endpoint: api.url, headers: { Authorization: { Vault: 'Bearer ${ACME_KEY' } } });
  t.after(async () => { await plugin.teardown?.(); api.close(); });
  assert.match(errorOf(events), /unterminated/);
  assert.deepEqual([asked.length, api.seen.length], [0, 0]);
});

test('a key not in the vault fails the connection, naming it and how to supply it', async t => {
  const api = await keyed();
  const { services, store } = machine({});
  const { events, plugin } = await add(services, { endpoint: api.url, headers: { Authorization: { Vault: 'Bearer ${ACME_KEY}' } } });
  t.after(async () => { await plugin.teardown?.(); api.close(); });
  assert.match(errorOf(events), /ACME_KEY.*store-key/s);
  assert.equal(store.get('servers'), undefined);
});

test('the key is read per request, so a replaced one is sent from the next request on', async t => {
  const api = await serve(method => method === 'tools/list' ? { result: { tools: [{ name: 'search' }] } } : { result: { content: [] } });
  const { services, settings, tools } = machine({ ACME_KEY: 'first' });
  const manager = new RemoteMcpManager(services, settings as never);
  t.after(() => { manager.closeAll(); api.close(); });
  await manager.add({ name: 'acme', endpoint: api.url, headers: { 'X-API-Key': { Vault: 'ACME_KEY' } } });
  await services.Vault.writeSecret('ACME_KEY', 'second');
  const search = tools.find(x => x.name === 'mcp__acme__search')!;
  for await (const _ of search.executor.execute({}, { signal: new AbortController().signal } as unknown as ToolContext)) { /* drain */ }
  assert.equal(api.seen.at(-1)?.['x-api-key'], 'second');
});

test('a redirect is not followed while a key is attached, and its error is redacted', async t => {
  const api = await serve(() => ({ status: 307, headers: { location: `http://127.0.0.1:1/?k=${SECRET}` }, raw: '' }));
  const { services, settings } = machine({ ACME_KEY: SECRET });
  const manager = new RemoteMcpManager(services, settings as never);
  t.after(() => { manager.closeAll(); api.close(); });
  await assert.rejects(manager.add({ name: 'acme', endpoint: api.url, headers: { 'X-API-Key': { Vault: 'ACME_KEY' } } }), (e: Error) => {
    assert.match(e.message, /Redirect not followed/);
    assert.ok(!e.message.includes(SECRET), e.message);
    return true;
  });
});

test('plain-string headers ask nothing and are sent as before', async t => {
  const api = await serve(method => method === 'tools/list' ? { result: { tools: [] } } : {});
  const { services } = machine({});
  const { events, asked, plugin } = await add(services, { endpoint: api.url, headers: { Authorization: 'Bearer literal' } });
  t.after(async () => { await plugin.teardown?.(); api.close(); });
  assert.ok(resultOf(events), JSON.stringify(events));
  assert.equal(asked.length, 0);
  assert.equal(api.seen[0]?.authorization, 'Bearer literal');
});
