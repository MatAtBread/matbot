import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatAdapter } from '@matatbread/matbot-provider-openai-compat';
import { AnthropicAdapter } from '@matatbread/matbot-provider-anthropic';
import type { CompletionEvent, ProviderConfig, Message } from '@matatbread/matbot-core';

// `done` is the terminal event of a provider stream: exactly one, always. openai-compat used to yield
// it twice on every healthy completion — once at the finish_reason and once from the trailing fallback
// that exists for streams which never reach one. Harmless in the runner (which breaks on the first),
// but it makes the event stream a liar, and anything counting completions off it double-counts.

const cfg: ProviderConfig = { name: 'x', module: 'x', model: 'm', credentials: { apiKey: 'k' } };
const msgs: Message[] = [{ id: '1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: '', traceId: 't' }];

function sse(chunks: unknown[]): void {
  globalThis.fetch = (async () => new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ch)}\n\n`));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )) as unknown as typeof fetch;
}

async function collect(it: AsyncIterable<CompletionEvent>): Promise<CompletionEvent[]> {
  const out: CompletionEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const dones = (evs: CompletionEvent[]) => evs.filter(e => e.type === 'done').length;

test('openai-compat terminates a healthy completion exactly once', async () => {
  sse([
    { choices: [{ delta: { content: 'hello' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  const evs = await collect(new OpenAICompatAdapter().complete(msgs, cfg, [], new AbortController().signal));
  assert.equal(dones(evs), 1);
  assert.equal(evs[evs.length - 1]!.type, 'done', 'and it is the last event');
});

test('openai-compat terminates a tool-call completion exactly once', async () => {
  sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const evs = await collect(new OpenAICompatAdapter().complete(msgs, cfg, [], new AbortController().signal));
  assert.equal(dones(evs), 1);
  assert.equal(evs.filter(e => e.type === 'tool-call').length, 1);
});

test('openai-compat still terminates a stream that never reached a finish_reason', async () => {
  // The case the trailing `done` exists for — a dropped connection mid-answer.
  sse([{ choices: [{ delta: { content: 'half a sen' } }] }]);
  const evs = await collect(new OpenAICompatAdapter().complete(msgs, cfg, [], new AbortController().signal));
  assert.equal(dones(evs), 1, 'still terminated');
});

test('openai-compat terminates once when the response was cut short', async () => {
  sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ]);
  const evs = await collect(new OpenAICompatAdapter().complete(msgs, cfg, [], new AbortController().signal));
  assert.equal(dones(evs), 1);
  assert.equal(evs.filter(e => e.type === 'truncated').length, 1, 'and reports the truncation once');
});

test('anthropic terminates exactly once', async () => {
  sse([
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]);
  const evs = await collect(new AnthropicAdapter().complete(msgs, cfg, [], new AbortController().signal));
  assert.equal(dones(evs), 1);
});
