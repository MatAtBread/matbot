import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOAIMessages } from '../../../plugins/providers/openai-compat/src/convert.js';
import { toAnthropicMessages } from '../../../plugins/providers/anthropic/src/convert.js';
import type { Message, MessageContent } from '@matatbread/matbot-core';

// Reasoning must never be replayed as PROSE.
//
// It used to be: a stored `reasoning` block became a `[Prior reasoning: …]` TEXT part on any turn that
// also had tool calls. That was wrong twice. It did not give the endpoint what it asks for (a reasoning
// field, not prose). And it was imitable — the model saw the pattern in its own prior turns and began
// emitting `[Prior reasoning: …` as ordinary output, so its reasoning leaked into the visible answer, in
// a text block that never closed its bracket. A field cannot be imitated; a sentence can.

const msg = (role: Message['role'], content: MessageContent[]): Message =>
  ({ id: 'm', role, content, createdAt: '', traceId: 't' });

const CC = { type: 'ephemeral' } as const;

const REASONING: MessageContent = { type: 'reasoning', reasoning: 'I should call the weather tool.' };
const CALL:      MessageContent = { type: 'tool-call', id: 'c1', name: 'weather', input: { city: 'London' } };

const withTools = () => [
  msg('user',      [{ type: 'text', text: 'weather?' }]),
  msg('assistant', [REASONING, CALL]),
  msg('tool',      [{ type: 'tool-result', id: 'c1', result: 'sunny' }]),
];

test('openai-compat replays reasoning on the field it was read from', () => {
  const wire = toOAIMessages(withTools());
  const assistant = wire.find(m => m.role === 'assistant')!;

  // `adapter.ts` reads reasoning from `delta.reasoning_content`; it goes back the same way. An
  // asymmetric round-trip is what created the leak.
  assert.equal(assistant.reasoning_content, 'I should call the weather tool.');
  assert.equal(assistant.content, undefined, 'and nothing lands in the visible prose channel');
  assert.equal(assistant.tool_calls?.length, 1, 'the call itself is unaffected');
});

test('openai-compat still drops reasoning on a plain-chat replay', () => {
  // Tokens for nothing — the endpoint ignores prior reasoning when there are no tool calls. This is the
  // one part of the original behaviour that was load-bearing, so it is kept deliberately.
  const wire = toOAIMessages([
    msg('user',      [{ type: 'text', text: 'hello' }]),
    msg('assistant', [REASONING, { type: 'text', text: 'hi there' }]),
  ]);
  const assistant = wire.find(m => m.role === 'assistant')!;
  assert.equal(assistant.reasoning_content, undefined);
  assert.equal(assistant.content, 'hi there');
});

test('anthropic elides foreign reasoning rather than voicing it', () => {
  // Only the openai-compat adapter produces a `reasoning` block, so one reaching the anthropic converter
  // came from another provider earlier in a mixed-provider session. The Messages API has no slot for it,
  // and putting another model's private reasoning into THIS one's prose is exactly the "never post
  // foreign round-trip state into a slot it doesn't belong in" rule.
  const messages  = toAnthropicMessages(withTools(), CC);
  const assistant = messages.find(m => m.role === 'assistant')!;
  const blocks = assistant.content as Array<{ type: string }>;
  assert.deepEqual(blocks.map(b => b.type), ['tool_use'], 'the call survives; the reasoning does not');
});

test('no converter puts the words "Prior reasoning" on the wire', () => {
  // The regression guard proper: whatever the shape, that phrase must not reach a model again — it is
  // what taught one to imitate it.
  const cases: Message[][] = [
    withTools(),
    [msg('assistant', [REASONING, CALL, { type: 'text', text: 'checking' }])],
    [msg('assistant', [REASONING])],
  ];
  for (const messages of cases) {
    assert.doesNotMatch(JSON.stringify(toOAIMessages(messages)), /Prior reasoning/);
    assert.doesNotMatch(JSON.stringify(toAnthropicMessages(messages, CC)), /Prior reasoning/);
  }
});
