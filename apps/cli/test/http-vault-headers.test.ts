import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PermissionDecision, PermissionRequest, Session, ToolContext, ToolEvent } from '@matatbread/matbot-core';
import { VaultImpl, createSession, permitted, refused } from '@matatbread/matbot-core';
import type { ToolInputValidator } from '@matatbread/matbot-core';
import { httpTool } from '../../../plugins/http/src/index.ts';
import { plugin as jsonValidation } from '../../../plugins/json-validation/src/index.ts';

// A header value may name a vault key, so a keyed API needs no secret in the conversation (#104). What
// these pin is that the key reaches only the origin a human approved for it: one gate call per key, on
// `<origin> <key>`, asked before the vault is read; no redirect followed while a key rides; and the value
// redacted from anything the tool hands back, errors included.

const SECRET = 'sk-test-0123456789';

interface Seen { url: string; headers: IncomingHttpHeaders }

async function serve(handler: (url: string, headers: IncomingHttpHeaders) => { status?: number; headers?: Record<string, string>; body?: string }):
  Promise<{ origin: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const r = handler(req.url ?? '', req.headers);
    res.writeHead(r.status ?? 200, r.headers ?? {});
    res.end(r.body ?? 'ok');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise(r => server.close(() => r())) };
}

async function run(input: Record<string, unknown>, decide: (req: PermissionRequest) => PermissionDecision = () => permitted('user')):
  Promise<{ events: ToolEvent[]; asked: PermissionRequest[]; reads: string[] }> {
  const asked: PermissionRequest[] = [];
  const reads: string[] = [];
  const vault = new VaultImpl({ ACME_KEY: SECRET, OTHER_KEY: 'other-secret-value' });
  const readSecret = vault.readSecret.bind(vault);
  vault.readSecret = async (name: string) => { reads.push(name); return readSecret(name); };
  const ctx = {
    callId: 'c1', session: createSession() as Session, signal: new AbortController().signal, vault,
    gate: async (req: PermissionRequest) => { asked.push(req); return decide(req); },
  } as unknown as ToolContext;
  const events: ToolEvent[] = [];
  for await (const ev of httpTool.executor.execute(input, ctx)) events.push(ev);
  return { events, asked, reads };
}

const only = (events: ToolEvent[]): ToolEvent => { assert.equal(events.length, 1, JSON.stringify(events)); return events[0]!; };
const errorOf = (events: ToolEvent[]): string => { const e = only(events); assert.equal(e.type, 'error', JSON.stringify(e)); return (e as { message: string }).message; };

test('a { Vault } header sends the stored value, asked about as <origin> <key>', async () => {
  const api = await serve(() => ({ body: 'fine' }));
  try {
    const { events, asked } = await run({ url: `${api.origin}/v1`, headers: { 'X-API-Key': { Vault: 'ACME_KEY' }, 'X-Trace': 'abc' } });
    assert.deepEqual(only(events), { type: 'result', value: 'fine' });
    assert.equal(api.seen[0]?.headers['x-api-key'], SECRET);
    assert.equal(api.seen[0]?.headers['x-trace'], 'abc');

    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.gate, 'secret');
    assert.equal(asked[0]?.subject, `${api.origin} ACME_KEY`);
    assert.equal(asked[0]?.fallback, false);
    // Names only, never the value; and never a "this key, any host" standing answer.
    assert.ok(!JSON.stringify(asked).includes(SECRET));
    assert.deepEqual(asked[0]?.standing?.map(s => s.subject), [`${api.origin} ACME_KEY`, api.origin]);
  } finally { await api.close(); }
});

test('plain-string headers ask nothing and are sent as before', async () => {
  const api = await serve(() => ({}));
  try {
    const { events, asked, reads } = await run({ url: api.origin, headers: { Authorization: 'Bearer literal' } });
    assert.equal(only(events).type, 'result');
    assert.equal(api.seen[0]?.headers.authorization, 'Bearer literal');
    assert.deepEqual([asked.length, reads.length], [0, 0]);
  } finally { await api.close(); }
});

test('one gate call per distinct key, and a refusal reads nothing and sends nothing', async () => {
  const api = await serve(() => ({}));
  try {
    const { events, asked, reads } = await run(
      { url: api.origin, headers: { A: { Vault: 'ACME_KEY' }, B: { Vault: 'OTHER_KEY' }, C: { Vault: 'ACME_KEY' } } },
      req => req.subject.endsWith(' OTHER_KEY') ? refused('user') : permitted('user'),
    );
    assert.deepEqual(asked.map(r => r.subject), [`${api.origin} ACME_KEY`, `${api.origin} OTHER_KEY`]);
    assert.match(errorOf(events), /OTHER_KEY.*the user declined/);
    assert.deepEqual(reads, []);
    assert.equal(api.seen.length, 0);
  } finally { await api.close(); }
});

test('a name that is not a key name is refused before anything is asked', async () => {
  // Through `resolve` this was `${A}${B}` — two lookups behind one approved name.
  const { events, asked, reads } = await run({ url: 'https://example.invalid', headers: { X: { Vault: 'A}${B' } } });
  assert.match(errorOf(events), /not a vault key name/);
  assert.deepEqual([asked.length, reads.length], [0, 0]);
});

test('a missing key points at store-key and does not prompt for the value', async () => {
  const api = await serve(() => ({}));
  try {
    const { events } = await run({ url: api.origin, headers: { X: { Vault: 'NOPE_KEY' } } });
    assert.match(errorOf(events), /NOPE_KEY.*store-key/);
    assert.equal(api.seen.length, 0);
  } finally { await api.close(); }
});

test('a key is only sent to an absolute http(s) URL', async () => {
  for (const url of ['/relative', 'data:text/plain,hi']) {
    const { events, asked } = await run({ url, headers: { X: { Vault: 'ACME_KEY' } } });
    assert.match(errorOf(events), /vault key can only be sent/);
    assert.equal(asked.length, 0);
  }
});

test('a redirect is not followed while a key is attached, and says where it pointed', async () => {
  const elsewhere = await serve(() => ({ body: 'captured' }));
  const api = await serve(() => ({ status: 302, headers: { location: `${elsewhere.origin}/steal` } }));
  try {
    const { events } = await run({ url: api.origin, headers: { 'X-API-Key': { Vault: 'ACME_KEY' } } });
    const message = errorOf(events);
    assert.match(message, /Redirect not followed/);
    assert.ok(message.includes(`${elsewhere.origin}/steal`));
    assert.equal(elsewhere.seen.length, 0);
  } finally { await api.close(); await elsewhere.close(); }

  // Without a key, redirects are followed exactly as before.
  const target = await serve(() => ({ body: 'landed' }));
  const hop = await serve(() => ({ status: 302, headers: { location: target.origin } }));
  try {
    assert.deepEqual(only((await run({ url: hop.origin })).events), { type: 'result', value: 'landed' });
  } finally { await hop.close(); await target.close(); }
});

test('an echoed key is redacted from results and errors — and nothing else is', async () => {
  const api = await serve((url, h) => url === '/fail'
    ? { status: 401, body: `bad key ${String(h['x-api-key'])}` }
    : { body: JSON.stringify({ echoed: h['x-api-key'], enabled: true, home: '/Users/someone' }) });
  try {
    const ok = only((await run({ url: api.origin, responseType: 'json', headers: { 'X-API-Key': { Vault: 'ACME_KEY' } } })).events);
    // `Vault.scrub` would redact every env value it holds (`true` included), which breaks the JSON.
    assert.deepEqual(ok, { type: 'result', value: { echoed: '[REDACTED]', enabled: true, home: '/Users/someone' } });

    const failed = errorOf((await run({ url: `${api.origin}/fail`, headers: { 'X-API-Key': { Vault: 'ACME_KEY' } } })).events);
    assert.equal(failed, 'HTTP 401: bad key [REDACTED]');
  } finally { await api.close(); }
});

test('the schema admits both arms and refuses the guesses a model makes', async () => {
  let validator: ToolInputValidator | undefined;
  await jsonValidation.setup?.({
    tools: { resolve: () => httpTool },
    register: async (_k: string, v: ToolInputValidator) => { validator = v; },
  } as never);
  assert.ok(validator);
  const check = async (value: unknown): Promise<string[]> =>
    ((await validator!.validateToolCall('http', { url: 'https://x', headers: { H: value } })) ?? []).map(e => `${e.path}: ${e.message}`);

  assert.deepEqual(await check('Bearer abc'), []);
  assert.deepEqual(await check({ Vault: 'ACME_KEY' }), []);
  assert.deepEqual(await check({ Vault: 'K', prefix: 'Bearer ' }), ['.headers.H.prefix: unexpected property']);
  assert.deepEqual(await check({}), ['.headers.H.Vault: required property missing']);
  assert.deepEqual(await check({ Vault: 1 }), ['.headers.H.Vault: expected string, got number']);
  assert.deepEqual(await check(['a']), ['.headers.H: expected one of string, object']);
});
