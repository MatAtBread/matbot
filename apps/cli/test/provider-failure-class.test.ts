import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatAdapter } from '@matatbread/matbot-provider-openai-compat';
import { AnthropicAdapter } from '@matatbread/matbot-provider-anthropic';
import { GoogleAdapter } from '@matatbread/matbot-provider-google';
import { ChatJimmyAdapter } from '@matatbread/matbot-provider-chatjimmy';
import { failureOf, failureForStatus } from '@matatbread/matbot-core';
import type { CompletionEvent, ProviderAdapter, ProviderConfig, Message } from '@matatbread/matbot-core';

// A provider's failure carries whether trying again could help. matbot does not retry on anyone's behalf;
// whoever called decides, and an overloaded endpoint (try later) and a rejected key (it will never work)
// were the same `Error` with a number inside its message — nothing a caller could branch on.

const cfg: ProviderConfig = { name: 'x', module: 'x', model: 'm', endpoint: 'https://example.invalid', credentials: { apiKey: 'k' } };
const msgs: Message[] = [{ id: '1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: '', traceId: 't' }];

const realFetch = globalThis.fetch;
function answer(res: () => Response): void {
  globalThis.fetch = (async () => res()) as unknown as typeof fetch;
}
const status = (code: number, body = 'nope') => () => new Response(body, { status: code });
const stream = (chunks: unknown[]) => () => new Response(
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.close();
    },
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

async function failure(adapter: ProviderAdapter): Promise<unknown> {
  try {
    for await (const _ of adapter.complete(msgs, cfg, [], new AbortController().signal) as AsyncIterable<CompletionEvent>) { /* drain */ }
  } catch (e) {
    return e;
  }
  assert.fail('the call did not fail');
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('an HTTP status is classified by what it means to a caller', () => {
  for (const s of [408, 409, 425, 429, 500, 502, 503, 504, 529]) assert.equal(failureForStatus(s), 'unavailable', String(s));
  for (const s of [401, 403]) assert.equal(failureForStatus(s), 'denied', String(s));
  for (const s of [400, 404, 413, 422, 501, 505]) assert.equal(failureForStatus(s), 'invalid', String(s));
  for (const s of [200, 302, 600]) assert.equal(failureForStatus(s), undefined, String(s));
});

const adapters: Array<[string, () => ProviderAdapter]> = [
  ['anthropic',     () => new AnthropicAdapter()],
  ['openai-compat', () => new OpenAICompatAdapter()],
  ['google',        () => new GoogleAdapter()],
  ['chatjimmy',     () => new ChatJimmyAdapter()],
];

for (const [name, make] of adapters) {
  test(`${name}: a refused request carries its class, and its message is unchanged`, async () => {
    answer(status(529, 'Overloaded'));
    const busy = await failure(make());
    assert.equal(failureOf(busy), 'unavailable');
    assert.match(String(busy), /529: Overloaded/, 'the status and body are still in the message');

    answer(status(401));
    assert.equal(failureOf(await failure(make())), 'denied');

    answer(status(400));
    assert.equal(failureOf(await failure(make())), 'invalid');
  });
}

test('anthropic: an error sent in the stream after the 200 is classified by its type', async () => {
  answer(stream([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]));
  const e = await failure(new AnthropicAdapter());
  assert.equal(failureOf(e), 'unavailable');
  assert.match(String(e), /Overloaded/);

  answer(stream([{ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } }]));
  assert.equal(failureOf(await failure(new AnthropicAdapter())), 'invalid');

  answer(stream([{ type: 'error', error: { type: 'something_new', message: '?' } }]));
  assert.equal(failureOf(await failure(new AnthropicAdapter())), undefined, 'a type it does not know is not guessed at');
});

test('google: an error sent in the stream after the 200 is classified by its status', async () => {
  answer(stream([{ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }]));
  assert.equal(failureOf(await failure(new GoogleAdapter())), 'unavailable');

  answer(stream([{ error: { status: 'PERMISSION_DENIED', message: 'no' } }]));
  assert.equal(failureOf(await failure(new GoogleAdapter())), 'denied');
});

// It used to be ignored: the turn ended as an "empty completion", with the endpoint's reason thrown away.
test('openai-compat: an error sent in the stream after the 200 ends the call, with its reason', async () => {
  answer(stream([{ error: { message: 'Provider returned error', code: 502 } }]));
  const e = await failure(new OpenAICompatAdapter());
  assert.match(String(e), /Provider returned error/);
  assert.equal(failureOf(e), 'unavailable');

  answer(stream([{ error: { message: 'model_not_found', code: 'model_not_found' } }]));
  assert.equal(failureOf(await failure(new OpenAICompatAdapter())), undefined, "a host's own word for it is not guessed at");
});

test('a network failure is left unclassified: a reset and a failed lookup look the same from here', async () => {
  globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  assert.equal(failureOf(await failure(new AnthropicAdapter())), undefined);
});
