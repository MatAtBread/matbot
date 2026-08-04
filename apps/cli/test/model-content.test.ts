import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier,
} from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  PipelineEvent, Principal, MessageContent, Message,
} from '@matatbread/matbot-core';
import { AnthropicAdapter } from '@matatbread/matbot-provider-anthropic';
import { GoogleAdapter } from '@matatbread/matbot-provider-google';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// A tool can hand the model something to LOOK at — a page image, a PDF — via a `model-content` event.
// It rides the wire pinned to the tool message it answers and never touches the session, so the
// transcript records what the tool returned rather than the bytes it showed. The durable home of the
// bytes is wherever the tool got them; a later turn that needs them calls the tool again.

const principal: Principal = { id: 'tester', type: 'user' };
const PNG  = 'iVBORw0KGgo=';
const PDF  = 'JVBERi0xLjQK';
// Message content is base64 of the file's BYTES; btoa alone would encode 'é' as one latin-1 byte,
// which is not what any store holding a UTF-8 document contains.
const b64utf8 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

function memStore(seed: Session): Store<Session> {
  const m = new Map<string, Session>([[seed.id, seed]]);
  return {
    get:    async id => m.get(id) ?? null,
    set:    async (id, v) => { m.set(id, v); },
    cas:    async () => { throw new Error('cas unused'); },
    delete: async () => { throw new Error('delete unused'); },
    query:  async () => { throw new Error('query unused'); },
  };
}

// Reads a page out of some store of its own and shows it to the model, returning only metadata.
const readPage: Tool = {
  name: 'read_page',
  description: 'fetches a page image',
  inputSchema: { type: 'object', properties: {} },
  executor: {
    async *execute() {
      yield { type: 'model-content', content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] };
      yield { type: 'result', value: { name: 'page-1.png', bytes: 8192 } };
    },
  },
};

function toolRegistry(tool: Tool): ToolRegistry {
  return {
    register:   () => { throw new Error('register unused'); },
    unregister: () => { throw new Error('unregister unused'); },
    resolve:    name => (name === tool.name ? tool : null),
    list:       () => [tool],
    has:        name => name === tool.name,
  } as unknown as ToolRegistry;
}

// Calls the tool twice, so there is a round AFTER the media arrived and another after that — enough to
// see whether it persists across the rest of the turn and stays pinned where it landed.
function twoCallProvider(seen: Message[][]): ProviderAdapter {
  let call = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      const n = call++;
      seen.push(messages);
      return (async function* () {
        if (n < 2) yield { type: 'tool-call', id: `c${n}`, name: 'read_page', input: {} };
        else       yield { type: 'text-delta', delta: 'it is a photo of a cat' };
        yield { type: 'done' };
      })();
    },
  };
}

function makeRunner(store: Store<Session>, adapter: ProviderAdapter) {
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  return createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config }),
    tools:           toolRegistry(readPage),
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });
}

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

async function run(store: Store<Session>, adapter: ProviderAdapter, sid: string): Promise<PipelineEvent[]> {
  const view = await makeRunner(store, adapter).open({
    sessionId: sid, signal: new AbortController().signal,
    content: text('what is on page 1?'), provider: 'fake', principal,
  });
  const events: PipelineEvent[] = [];
  for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; }
  return events;
}

test('tool media reaches the model and stays for the rest of the turn', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const seen: Message[][] = [];

  await run(store, twoCallProvider(seen), session.id);
  assert.equal(seen.length, 3, 'three provider calls');

  const imagesIn = (msgs: Message[]) =>
    msgs.flatMap(m => m.content).filter(c => c.type === 'image').length;

  assert.equal(imagesIn(seen[0]!), 0, 'nothing before the tool ran');
  assert.equal(imagesIn(seen[1]!), 1, 'the first call\'s image is on the wire');
  assert.equal(imagesIn(seen[2]!), 2, 'both remain — content already seen is never withdrawn mid-turn');

  // Pinned to the tool message it answers, not swept to the tail.
  const last    = seen[2]!;
  const toolIdx = last.findIndex(m => m.role === 'tool');
  assert.equal(last[toolIdx + 1]?.role, 'user', 'media follows its tool message');
  assert.equal(last[toolIdx + 1]?.content[0]?.type, 'image');
  assert.ok(toolIdx + 1 < last.length - 1, 'and it is not merely the tail');
});

test('tool media is never persisted', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);

  await run(store, twoCallProvider([]), session.id);

  const saved  = (await store.get(session.id))!;
  const blocks = saved.messages.flatMap(m => m.content);
  assert.equal(blocks.filter(c => c.type === 'image').length, 0, 'no image survived into the store');

  // What DID survive is the tool's own account of what it did.
  const results = blocks.filter(c => c.type === 'tool-result');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0]!.result, { name: 'page-1.png', bytes: 8192 });
});

// ── Wire rendering ────────────────────────────────────────────────────────────

function captureBody(): { body: () => any } {
  let captured: unknown;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    return new Response(new ReadableStream<Uint8Array>({ start: c => c.close() }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { body: () => captured };
}

const cfg: ProviderConfig = { name: 'x', module: 'x', model: 'm', credentials: { apiKey: 'k' } };

function msg(role: Message['role'], content: MessageContent[]): Message {
  return { id: crypto.randomUUID(), role, content, createdAt: '', traceId: 't' };
}

async function drain(it: AsyncIterable<CompletionEvent>): Promise<void> {
  for await (const _ of it) { /* body already captured */ }
}

test('anthropic renders a PDF natively and folds adjacent user messages', { timeout: 15000 }, async () => {
  const cap = captureBody();
  await drain(new AnthropicAdapter().complete([
    msg('user',      text('read this')),
    msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'read_page', input: {} }]),
    msg('tool',      [{ type: 'tool-result', id: 'c1', result: { ok: true } }]),
    msg('user',      [{ type: 'document', data: PDF, mimeType: 'application/pdf', name: 'report.pdf' }]),
  ], cfg, [], new AbortController().signal));

  const msgs = cap.body().messages as Array<{ role: string; content: any[] }>;

  // The tool result and the media it produced are one user message, not two in a row.
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'user']);
  const tail = msgs[2]!.content;
  assert.equal(tail[0].type, 'tool_result', 'tool_result blocks still come first');
  assert.equal(tail[1].type, 'document');
  assert.equal(tail[1].title, 'report.pdf');
  assert.deepEqual(tail[1].source, { type: 'base64', media_type: 'application/pdf', data: PDF });
});

test('anthropic sends a text document decoded, and degrades what it cannot carry', { timeout: 15000 }, async () => {
  const cap = captureBody();
  await drain(new AnthropicAdapter().complete([
    msg('user', [
      { type: 'document', data: b64utf8('héllo'), mimeType: 'text/markdown' },
      { type: 'audio',    data: PNG, mimeType: 'audio/mpeg' },
    ]),
  ], cfg, [], new AbortController().signal));

  const content = (cap.body().messages as Array<{ content: any[] }>)[0]!.content;
  assert.deepEqual(content[0].source, { type: 'text', media_type: 'text/plain', data: 'héllo' });
  assert.equal(content[1].type, 'text', 'audio has no Anthropic representation');
  assert.match(content[1].text, /^\[Audio: audio\/mpeg\]$/);
});

test('google sends documents and audio as inline data', { timeout: 15000 }, async () => {
  const cap = captureBody();
  await drain(new GoogleAdapter().complete([
    msg('user', [
      { type: 'document', data: PDF, mimeType: 'application/pdf', name: 'report.pdf' },
      { type: 'audio',    data: PNG, mimeType: 'audio/mpeg' },
    ]),
  ], { ...cfg, endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
     [], new AbortController().signal));

  const parts = (cap.body().contents as Array<{ parts: any[] }>)[0]!.parts;
  assert.deepEqual(parts, [
    { inlineData: { mimeType: 'application/pdf', data: PDF } },
    { inlineData: { mimeType: 'audio/mpeg',      data: PNG } },
  ]);
});
