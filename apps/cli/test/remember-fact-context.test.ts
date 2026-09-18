import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '@matatbread/matbot-plugin-api';
import { extractionPrompt } from '../../../plugins/cognition/src/remember/tool.ts';

// `remember_fact` extracted from one message with no context and was told to normalise every fact to
// "the user", so a pasted transcript belonging to the user's son became the user's own marks and award
// date (#74). The subject is usually named a turn earlier, so the extractor must see that turn — and be
// told which message is the one to extract from, and who wrote it.

function msg(id: string, role: Message['role'], text: string, robo = false): Message {
  return {
    id, role, traceId: 't', createdAt: new Date(0).toISOString(),
    content: [{ type: 'text', text, ...(robo ? { origin: 'robo' as const } : {}) }],
  } as Message;
}

test('the preceding turns are supplied as context, apart from the message to extract from', () => {
  const messages = [
    msg('m1', 'user',      'first'),
    msg('m2', 'assistant', 'second'),
    msg('m3', 'user',      "Here is my son Alex's degree transcript"),
    msg('m4', 'assistant', 'Thanks — what would you like to know?'),
    msg('m5', 'user',      'Total CATS Points: 340\nClassification/Grade: Pass'),
  ];
  const prompt = extractionPrompt(messages, messages[4]!);

  assert.doesNotMatch(prompt, /first/, 'only the last few messages are context');
  assert.match(prompt, /ASSISTANT: second[\s\S]*USER: Here is my son Alex's degree transcript/);
  const [context, body] = prompt.split('[The message to extract from, written by the USER:]');
  assert.match(context!, /CONTEXT ONLY/);
  assert.equal(body, '\nTotal CATS Points: 340\nClassification/Grade: Pass');
});

test('an assistant-written message is labelled as such', () => {
  const messages = [msg('m1', 'user', 'the table is pgdwell'), msg('m2', 'assistant', "I'll remember the table is pgdwell")];
  assert.match(extractionPrompt(messages, messages[1]!), /written by the ASSISTANT:\]\nI'll remember/);
});

test('with nothing before it, the message stands alone', () => {
  const messages = [msg('m1', 'user', 'my neighbours are the Smiths')];
  assert.equal(extractionPrompt(messages, messages[0]!), '[The message to extract from, written by the USER:]\nmy neighbours are the Smiths');
});

test('robo-injected text is not context, and long messages are clipped', () => {
  const messages = [
    msg('m1', 'user', 'SKILL TEXT', true),
    msg('m2', 'user', 'x'.repeat(5000)),
    msg('m3', 'user', 'go'),
  ];
  const prompt = extractionPrompt(messages, messages[2]!);
  assert.doesNotMatch(prompt, /SKILL TEXT/);
  assert.match(prompt, /x{1500}…\[truncated\]/);
  assert.doesNotMatch(prompt, /x{1501}/);
});
