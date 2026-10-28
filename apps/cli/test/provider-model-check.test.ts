import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderRegistryImpl, bindGate, checkProviderModel, closestIds, modelListed, CONFIRM_YES, CONFIRM_NO } from '@matatbread/matbot-core';
import { createProviderTool } from '@matatbread/matbot-tool-plugin';
import { AnthropicAdapter } from '@matatbread/matbot-provider-anthropic';
import { OpenAICompatAdapter } from '@matatbread/matbot-provider-openai-compat';
import { GoogleAdapter } from '@matatbread/matbot-provider-google';
import type { ProviderAdapter, ProviderConfig, PromptFn, ToolContext, ToolEvent, FormField } from '@matatbread/matbot-core';

// A mistyped model is otherwise found by the next turn failing, as a 404 that reads like a key or endpoint
// fault. The endpoints can say which models they serve, so the name is checked where it is typed.

async function serve(handler: (q: IncomingMessage, r: ServerResponse) => void): Promise<{ base: string; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const server = createServer((q, r) => { seen.push(`${q.url} ${q.headers['x-api-key'] ?? q.headers['x-goog-api-key'] ?? q.headers['authorization'] ?? ''}`); handler(q, r); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
const json = (r: ServerResponse, body: unknown): void => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(body)); };
const literal = { resolve: async (s: string): Promise<string> => s };
const cfg = (over: Partial<ProviderConfig>): ProviderConfig => ({ name: 'p', module: 'm', model: 'x', ...over });

test('an endpoint accepts names it does not list, and those count as listed', () => {
  assert.equal(modelListed('claude-sonnet-4-5', ['claude-sonnet-4-5-20250929']), true);   // undated alias
  assert.equal(modelListed('claude-3-5-sonnet-latest', ['claude-3-5-sonnet-20241022']), true);
  assert.equal(modelListed('llama3', ['llama3:latest']), true);                              // ollama tag
  assert.equal(modelListed('models/gemini-2.5-flash', ['gemini-2.5-flash']), true);
  assert.equal(modelListed('gemini-2.5-flash', ['models/gemini-2.5-flash']), true);
  assert.equal(modelListed('gpt-4o-mni', ['gpt-4o-mini', 'gpt-4o']), false);
  // A date suffix only: a longer name sharing the prefix is a different model.
  assert.equal(modelListed('gpt-4o', ['gpt-4o-mini']), false);
});

test('a typo ranks its intended id first, ahead of siblings sharing more segments', () => {
  const ids = ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-mini', 'text-embedding-3-small', 'whisper-1'];
  assert.equal(closestIds('gpt-4o-mni', ids)[0], 'gpt-4o-mini');
  assert.equal(closestIds('claude-sonet-4-6', ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'])[0], 'claude-sonnet-4-6');
  assert.equal(closestIds('qwen3-4b', ['Llama-3.2-1B-q4f16_1-MLC', 'Qwen3-4B-q4f16_1-MLC'])[0], 'Qwen3-4B-q4f16_1-MLC');
  assert.ok(!closestIds('gpt-4o-mni', ids).includes('whisper-1'));
});

test('anthropic lists every page, with its key', async () => {
  const s = await serve((q, r) => {
    const after = new URL(q.url!, 'http://x').searchParams.get('after_id');
    json(r, after === null
      ? { data: [{ id: 'claude-a' }, { id: 'claude-b' }], has_more: true, last_id: 'claude-b' }
      : { data: [{ id: 'claude-c' }], has_more: false, last_id: 'claude-c' });
  });
  try {
    const ids = await new AnthropicAdapter().models(cfg({ endpoint: s.base, credentials: { apiKey: 'sk-a' } }));
    assert.deepEqual(ids, ['claude-a', 'claude-b', 'claude-c']);
    assert.match(s.seen[0]!, /^\/v1\/models\?limit=1000 sk-a$/);
    assert.match(s.seen[1]!, /after_id=claude-b/);
  } finally { await s.close(); }
});

test('openai-compat lists beside its chat-completions URL, or under a bare base', async () => {
  const s = await serve((_q, r) => json(r, { object: 'list', data: [{ id: 'gpt-4o' }, { id: 'models/gemini-2.5-flash' }] }));
  try {
    const a = new OpenAICompatAdapter();
    assert.deepEqual(await a.models(cfg({ endpoint: `${s.base}/v1/chat/completions`, credentials: { apiKey: 'sk-o' } })),
                     ['gpt-4o', 'gemini-2.5-flash']);
    await a.models(cfg({ endpoint: `${s.base}/v1beta/openai/` }));
    assert.deepEqual(s.seen, ['/v1/models Bearer sk-o', '/v1beta/openai/models Bearer']);
  } finally { await s.close(); }
});

test('google lists generative models only, by bare id, from a base or a full model URL', async () => {
  const s = await serve((_q, r) => json(r, { models: [
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  ] }));
  try {
    const g = new GoogleAdapter();
    assert.deepEqual(await g.models(cfg({ endpoint: `${s.base}/v1beta`, credentials: { apiKey: 'g' } })), ['gemini-2.5-flash']);
    await g.models(cfg({ endpoint: `${s.base}/v1beta/models/{model}:generateContent?key=leak` }));
    assert.match(s.seen[0]!, /^\/v1beta\/models\?pageSize=1000 g$/);
    assert.match(s.seen[1]!, /^\/v1beta\/models\?pageSize=1000 $/);          // the query's key is not carried
  } finally { await s.close(); }
});

test('a credential the vault does not hold sends nothing (an endpoint moved to another origin)', async () => {
  let called = false;
  const adapter: Pick<ProviderAdapter, 'models'> = { models: async () => { called = true; return ['x']; } };
  const vault = { resolve: async (s: string): Promise<string> => { throw new Error(`missing secret in ${s}`); } };
  const check = await checkProviderModel(adapter, cfg({ credentials: { apiKey: '${MATBOT_API_KEY_P}' } }), vault);
  assert.equal(check.kind, 'unchecked');
  assert.equal(called, false);
});

test('a list that never answers is given up on, even by an adapter that ignores the signal', async () => {
  const adapter: Pick<ProviderAdapter, 'models'> = { models: () => new Promise<string[]>(() => {}) };
  const started = Date.now();
  const check = await checkProviderModel(adapter, cfg({}), literal, 50);
  assert.deepEqual(check, { kind: 'unchecked', reason: 'no answer within 0.05s' });
  assert.ok(Date.now() - started < 2_000);
});

// ── provider add ─────────────────────────────────────────────────────────────

async function runAdd(model: string, answers: string[], models: () => Promise<string[]>) {
  const dir  = await mkdtemp(join(tmpdir(), 'mb-provider-model-'));
  const file = join(dir, 'matbot.yaml');
  await writeFile(file, 'providers:\n  other:\n    module: x\n    model: y\n', 'utf8');
  const listedWith: ProviderConfig[] = [];
  const adapter = { models: async (c: ProviderConfig) => { listedWith.push(c); return models(); } } as unknown as ProviderAdapter;
  const prompts: string[] = [];
  const ask = (async (q: unknown) => { prompts.push(typeof q === 'string' ? q : (q as FormField).label); return answers.shift() ?? CONFIRM_YES; }) as PromptFn;
  const ctx = {
    configPath: file,
    session:    { id: 's1', messages: [] },
    signal:     new AbortController().signal,
    prompt:     ask,
    vault:      { hasKey: () => true, resolve: async (s: string) => s.replace('${OPENAI_KEY}', 'sk-real') },
    loadPlugin: async (spec: string) => ({ name: spec, provider: () => adapter }),
    ...bindGate(undefined, 'provider', ask),
  } as unknown as ToolContext;
  const providers = new ProviderRegistryImpl([]);
  const events: ToolEvent<unknown>[] = [];
  const input = { action: 'add', name: 'oai', module: '@test/fake-adapter', model, credentialEnvVar: 'OPENAI_KEY' };
  for await (const e of createProviderTool(providers).executor.execute(input, ctx)) events.push(e);
  const result = events.find(e => e.type === 'result' || e.type === 'error') as { value?: { message: string } };
  return { prompts, providers, listedWith, message: result.value?.message ?? '', yaml: await readFile(file, 'utf8'), events };
}

test('add: an unlisted model is asked about only after the profile is approved, and a no names the closest', async () => {
  const r = await runAdd('gpt-4o-mni', [CONFIRM_YES, CONFIRM_NO], async () => ['gpt-4o', 'gpt-4o-mini']);

  // Listing sends the key, so the profile's own approval comes first.
  assert.equal(r.prompts.length, 2);
  assert.match(r.prompts[0]!, /Add provider profile \*\*"oai"\*\*/);
  assert.match(r.prompts[1]!, /"gpt-4o-mni"\*\* is not among the 2 models the endpoint lists\. Closest: gpt-4o-mini/);
  assert.deepEqual(r.listedWith[0]!.credentials, { apiKey: 'sk-real' });

  assert.match(r.message, /the user declined/);
  assert.match(r.message, /Closest: gpt-4o-mini/);
  assert.equal(r.providers.has('oai'), false);
  assert.doesNotMatch(r.yaml, /oai:/);
});

test('add: declining the profile itself lists nothing', async () => {
  const r = await runAdd('gpt-4o', [CONFIRM_NO], async () => ['gpt-4o']);
  assert.equal(r.listedWith.length, 0);
  assert.equal(r.providers.has('oai'), false);
});

test('add: a listed model needs no second question, and an unlisted one confirmed is added as typed', async () => {
  const listed = await runAdd('gpt-4o', [CONFIRM_YES], async () => ['gpt-4o']);
  assert.equal(listed.prompts.length, 1);
  assert.equal(listed.providers.get('oai')?.model, 'gpt-4o');

  const confirmed = await runAdd('my-azure-deployment', [CONFIRM_YES, CONFIRM_YES], async () => ['gpt-4o']);
  assert.equal(confirmed.prompts.length, 2);
  assert.equal(confirmed.providers.get('oai')?.model, 'my-azure-deployment');
});

test('add: an endpoint that cannot list is not a reason to refuse', async () => {
  const r = await runAdd('gpt-4o', [CONFIRM_YES], async () => { throw new Error('OpenAI-compat 404: not found'); });
  assert.equal(r.providers.get('oai')?.model, 'gpt-4o');
  assert.ok(r.events.some(e => e.type === 'stdout' && /not checked/.test((e as { chunk: string }).chunk)));
});
