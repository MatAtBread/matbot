import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textDocument } from '@matatbread/matbot-core/providers-base';
import type { Message } from '@matatbread/matbot-core';
import { toAnthropicMessages } from '../../../plugins/providers/anthropic/src/convert.ts';
import { toOAIMessages } from '../../../plugins/providers/openai-compat/src/convert.ts';
import { toGeminiContents } from '../../../plugins/providers/google/src/convert.ts';

// A text file a person attaches must reach the model as TEXT, in every adapter.
//
// It used to reach it as each protocol's document block, or as a `[Document: x]` note where the
// protocol has none — and the one protocol that does have a text source block is fronted by vendor
// shims that silently discard it: DeepSeek's Anthropic-compatible endpoint substitutes the literal
// "[Unsupported Document]". The model was then told a CSV was attached and shown nothing, which reads
// to it as a lost attachment to go hunting for rather than as an absence. Hence the one rule these
// tests hold: for a textual type the bytes are in the prompt, as text, named.

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

function userDoc(mimeType: string, body: string, name?: string): Message[] {
  return [{
    id: 'm1', role: 'user', createdAt: new Date().toISOString(),
    content: [{ type: 'document', mimeType, data: b64(body), ...(name !== undefined ? { name } : {}) }],
  }] as Message[];
}

test('a textual document becomes named text; the bytes are there verbatim', () => {
  const got = textDocument({ mimeType: 'text/csv', data: b64('a,b\n1,2\n'), name: 'cost.csv' });
  assert.equal(got, '--- cost.csv ---\na,b\n1,2\n\n--- end of cost.csv ---');
});

test('textual means more than text/*: json, yaml and a +json suffix all qualify', () => {
  for (const mime of ['text/csv', 'text/plain', 'text/markdown', 'application/json',
                      'application/yaml', 'application/x-yaml', 'application/vnd.api+json',
                      'application/xml', 'application/atom+xml', 'application/toml']) {
    assert.notEqual(textDocument({ mimeType: mime, data: b64('hello') }), null, mime);
  }
  // A charset parameter is not part of the type.
  assert.notEqual(textDocument({ mimeType: 'text/csv; charset=utf-8', data: b64('a,b') }), null);
});

test('a non-textual type is left to the adapter, and binary is never guessed to be text', () => {
  assert.equal(textDocument({ mimeType: 'application/pdf', data: b64('%PDF-1.4') }), null);
  // The browser hands over octet-stream for any extension the OS could not place. Sniffing it would
  // mean calling binary "text" on the strength of it happening to decode.
  assert.equal(textDocument({ mimeType: 'application/octet-stream', data: b64('a,b') }), null);
  // A mislabelled binary must not reach a prompt as mojibake: the decode is fatal.
  assert.equal(textDocument({ mimeType: 'text/csv', data: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') }), null);
});

test('no name: the type stands in, rather than the framing naming nothing', () => {
  assert.equal(textDocument({ mimeType: 'text/plain', data: b64('x') }),
    '--- text/plain ---\nx\n--- end of text/plain ---');
});

test('anthropic inlines a text file as text, not as a document block a shim can discard', () => {
  const [msg] = toAnthropicMessages(userDoc('text/csv', 'a,b\n1,2\n', 'cost.csv'), { type: 'ephemeral' });
  assert.equal(msg?.content.length, 1);
  const [block] = msg!.content as { type: string; text?: string }[];
  assert.equal(block?.type, 'text');
  assert.equal(block?.text, '--- cost.csv ---\na,b\n1,2\n\n--- end of cost.csv ---');
});

test('anthropic keeps the document block for a PDF, which has no text form', () => {
  const [msg] = toAnthropicMessages(userDoc('application/pdf', '%PDF-1.4', 'r.pdf'), { type: 'ephemeral' });
  assert.equal((msg?.content[0] as { type: string }).type, 'document');
});

test('openai-compat inlines a text file instead of announcing one it then withholds', () => {
  const [msg] = toOAIMessages(userDoc('application/json', '{"a":1}', 'd.json'));
  assert.equal(msg?.content, '--- d.json ---\n{"a":1}\n--- end of d.json ---');
});

test('openai-compat still degrades a PDF to a note, having nowhere to put it', () => {
  const [msg] = toOAIMessages(userDoc('application/pdf', '%PDF-1.4', 'r.pdf'));
  assert.equal(msg?.content, '[Document: r.pdf]');
});

test('google sends a text part, which survives its openai-compat fallback; inlineData for the rest', () => {
  const [text] = toGeminiContents(userDoc('text/csv', 'a,b\n', 'cost.csv'));
  assert.deepEqual(text?.parts, [{ text: '--- cost.csv ---\na,b\n\n--- end of cost.csv ---' }]);
  const [pdf] = toGeminiContents(userDoc('application/pdf', '%PDF-1.4', 'r.pdf'));
  assert.ok((pdf?.parts[0] as { inlineData?: unknown }).inlineData, 'a PDF still goes as inlineData');
});
