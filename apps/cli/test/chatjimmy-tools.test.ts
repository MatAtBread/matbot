import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatJimmyAdapter } from '@matatbread/matbot-provider-chatjimmy';
import type { CompletionEvent, ProviderConfig, Message, Tool } from '@matatbread/matbot-core';

// The replies below are what Llama 3.1 8B on chatjimmy.ai actually wrote, given the tools prompt.

const tools: Tool[] = [
  { name: 'get_weather', description: 'Current weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, executor: { execute: async function* () { /* unused */ } } } as unknown as Tool,
  { name: 'bash', description: 'Run a shell command', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, executor: { execute: async function* () { /* unused */ } } } as unknown as Tool,
];

const withTools: ProviderConfig = { name: 'jimmy', module: 'x' };
const plain:     ProviderConfig = { name: 'jimmy', module: 'x', parameters: { tools: false } };

const msg = (role: Message['role'], content: Message['content']): Message => ({ id: crypto.randomUUID(), role, content, createdAt: '', traceId: 't' });
const ask = (text: string): Message[] => [msg('user', [{ type: 'text', text }])];

let sent: { messages: Array<{ role: string; content: string }>; chatOptions: { systemPrompt: string } } | undefined;
function reply(text: string, doneReason = 'stop'): void {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return new Response(`${text}\n<|stats|>{"prefill_tokens":10,"decode_tokens":5,"total_tokens":15,"done_reason":"${doneReason}"}<|/stats|>`, { status: 200 });
  }) as unknown as typeof fetch;
}

async function run(messages: Message[], config = withTools, offered = tools): Promise<CompletionEvent[]> {
  const out: CompletionEvent[] = [];
  for await (const e of new ChatJimmyAdapter().complete(messages, config, offered, new AbortController().signal)) out.push(e);
  return out;
}

const calls = (evs: CompletionEvent[]) => evs.flatMap(e => e.type === 'tool-call' ? [{ name: e.name, input: e.input, truncated: e.truncated }] : []);
const textOf = (evs: CompletionEvent[]) => evs.flatMap(e => e.type === 'text-delta' ? [e.delta] : []).join('');

test('chatjimmy offers no tools when the profile opts out', async () => {
  reply('<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>');
  const evs = await run(ask('list files'), plain);
  assert.deepEqual(calls(evs), []);
  assert.doesNotMatch(sent!.chatOptions.systemPrompt, /<tools>/);
  assert.match(textOf(evs), /<tool_call>/, 'the reply is passed through as text, as before');
});

test('chatjimmy describes the tools in the system prompt, after the caller\'s own', async () => {
  reply('Hello!');
  await run([msg('system', [{ type: 'text', text: 'You are terse.' }]), ...ask('hi')]);
  const sys = sent!.chatOptions.systemPrompt;
  assert.ok(sys.startsWith('You are terse.\n\n# Tools'));
  assert.match(sys, /"name":"get_weather"/);
  assert.match(sys, /"name":"bash"/);
});

test('chatjimmy reads a tagged call', async () => {
  reply('<tool_call>\n{"name": "get_weather", "arguments": {"city": "Leeds", "unit": "f"}}\n</tool_call>');
  const evs = await run(ask('weather in Leeds?'));
  assert.deepEqual(calls(evs), [{ name: 'get_weather', input: { city: 'Leeds', unit: 'f' }, truncated: undefined }]);
  assert.equal(textOf(evs), '');
  assert.equal(evs.at(-1)!.type, 'done');
});

test('chatjimmy keeps only the first call, dropping what the model invented after it', async () => {
  reply('<tool_call>\n{"name": "bash", "arguments": {"command": "ls /tmp | wc -l"}}\n</tool_call>\n'
    + '<tool_call>\n{"name": "get_weather", "arguments": {"city": "New York", "unit": "f"}}\n</tool_call>\n'
    + '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Chicago", "unit": "f"}}\n</tool_call>');
  const evs = await run(ask('List the files in /tmp'));
  assert.deepEqual(calls(evs).map(c => c.name), ['bash']);
  assert.equal(textOf(evs), '');
});

test('chatjimmy keeps up to maxCalls calls', async () => {
  reply('<tool_call>\n  {"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>\n'
    + '<tool_call>\n  {"name": "get_weather", "arguments": {"city": "Rome"}}\n</tool_call>');
  const evs = await run(ask('Paris and Rome?'), { ...withTools, parameters: { maxCalls: 2 } });
  assert.deepEqual(calls(evs).map(c => c.input), [{ city: 'Paris' }, { city: 'Rome' }]);
});

test('chatjimmy drops a guessed result written after a bare call', async () => {
  reply('{"name": "get_weather", "parameters": {"city": "Manchester"}}_message={"status": "OK", "message": "{\'tempC\': 12}"}');
  const evs = await run(ask('weather?'));
  assert.deepEqual(calls(evs), [{ name: 'get_weather', input: { city: 'Manchester' }, truncated: undefined }], 'Llama\'s `parameters` key is read too');
  assert.equal(textOf(evs), '');
});

test('chatjimmy shows, and does not run, a call whose arguments are not an object', async () => {
  reply('<tool_call>\n{"name": "bash", "arguments": "ls /tmp"}\n</tool_call>');
  const evs = await run(ask('list /tmp'));
  assert.deepEqual(calls(evs), []);
  assert.match(textOf(evs), /"arguments": "ls \/tmp"/);
});

test('chatjimmy reports a call cut off at the token limit as truncated', async () => {
  reply('Let me check.\n<tool_call>\n{"name": "bash", "arguments": {"command": "find / -na', 'length');
  const evs = await run(ask('find it'));
  assert.equal(textOf(evs), 'Let me check.');
  assert.deepEqual(calls(evs), [{ name: 'bash', input: {}, truncated: { bytes: 54, stopReason: 'length' } }]);
  assert.ok(evs.some(e => e.type === 'truncated'));
});

test('chatjimmy leaves prose with braces in it alone', async () => {
  reply('In JSON that is {"city": "Leeds"} — no call needed.');
  const evs = await run(ask('how do I write it?'));
  assert.deepEqual(calls(evs), []);
  assert.equal(textOf(evs), 'In JSON that is {"city": "Leeds"} — no call needed.');
});

test('chatjimmy replays a call and its result, framed with the question it is for', async () => {
  reply('It is 11°C and drizzling in Leeds.');
  const evs = await run([
    ...ask('Weather in Leeds?'),
    msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'get_weather', input: { city: 'Leeds' } }]),
    msg('tool', [{ type: 'tool-result', id: 'c1', result: { tempC: 11, sky: 'drizzle' } }]),
  ]);
  assert.equal(textOf(evs), 'It is 11°C and drizzling in Leeds.');
  assert.deepEqual(sent!.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(sent!.messages[1]!.content, '<tool_call>\n{"name": "get_weather", "arguments": {"city":"Leeds"}}\n</tool_call>');
  assert.equal(sent!.messages[2]!.content, '<tool_response>\n{"tempC":11,"sky":"drizzle"}\n</tool_response>\n'
    + 'That is the result of your get_weather call.\nThe user asked: "Weather in Leeds?"\n'
    + 'Use this result: call the next function you need with a <tool_call>, or answer the user.');
});

test('chatjimmy says when a replayed result was an error', async () => {
  reply('Sorry, that failed.');
  await run([
    ...ask('run it'),
    msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'bash', input: { command: 'x' } }]),
    msg('tool', [{ type: 'tool-result', id: 'c1', result: 'command not found', isError: true }]),
  ]);
  assert.match(sent!.messages[2]!.content, /your bash call, which reported an error\.\nThe user asked: "run it"/);
});

test('chatjimmy without tools still replays text only', async () => {
  reply('ok');
  await run([
    ...ask('Weather in Leeds?'),
    msg('assistant', [{ type: 'text', text: 'Checking.' }, { type: 'tool-call', id: 'c1', name: 'get_weather', input: {} }]),
    msg('tool', [{ type: 'tool-result', id: 'c1', result: 'x' }]),
    ...ask('thanks'),
  ], plain);
  assert.deepEqual(sent!.messages, [
    { role: 'user', content: 'Weather in Leeds?' },
    { role: 'assistant', content: 'Checking.' },
    { role: 'user', content: 'thanks' },
  ]);
});

// matbot's tool surface is several times chatjimmy's ~6k-token window: past it the endpoint answers 200 with
// an empty body, which was a run of silent empty turns as soon as `tool_search` loaded its finds.

const bigTool = (name: string, chars: number): Tool => ({
  name, description: `Does ${name}.\n\n${'More detail about it. '.repeat(Math.ceil(chars / 22))}`,
  inputSchema: { type: 'object', properties: { q: { type: 'string', description: `The query, e.g. a name. ${'Longer explanation. '.repeat(20)}` } } },
  executor: { execute: async function* () { /* unused */ } },
}) as unknown as Tool;

test('chatjimmy sends everything when it fits', async () => {
  reply('ok');
  await run(ask('hi'));
  assert.match(sent!.chatOptions.systemPrompt, /"description":"Current weather for a city"/);
  assert.doesNotMatch(sent!.chatOptions.systemPrompt, /left out/);
});

test('chatjimmy shortens tool descriptions to fit, keeping their structure', async () => {
  reply('ok');
  const many = Array.from({ length: 6 }, (_, i) => bigTool(`tool_${i}`, 4000));
  await run(ask('hi'), withTools, many);
  const sys = sent!.chatOptions.systemPrompt;
  for (let i = 0; i < 6; i++) assert.match(sys, new RegExp(`"name":"tool_${i}"`), 'every tool still listed');
  assert.doesNotMatch(sys, /More detail about it/, 'only the first paragraph of a description');
  assert.match(sys, /"description":"The query, e\.g\. a name\."/, 'a schema description is cut at its first sentence, not at "e.g."');
});

test('chatjimmy drops the tools least likely to be needed, keeping what tool_search just found', async () => {
  reply('ok');
  const search = { ...bigTool('tool_search', 100), description: 'Find tools.' } as Tool;
  const many = [search, ...Array.from({ length: 200 }, (_, i) => bigTool(`tool_${i}`, 300))];
  await run([
    ...ask('do the thing'),
    msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'tool_search', input: { query: 'thing' } }]),
    msg('tool', [{ type: 'tool-result', id: 'c1', result: { found: [{ name: 'tool_199' }, { name: 'tool_198' }] } }]),
  ], withTools, many);
  const sys = sent!.chatOptions.systemPrompt;
  assert.match(sys, /"name":"tool_199"/);
  assert.match(sys, /"name":"tool_198"/);
  assert.doesNotMatch(sys, /"name":"tool_197"/, 'the last offered tool not named by the result is dropped first');
  assert.match(sys, /\d+ more tools are available but not listed here; tool_search finds them\./);
});

test('chatjimmy leaves out the earliest turns to fit, and says so', async () => {
  reply('ok');
  const long = 'blah '.repeat(2000);
  await run([...ask(`first ${long}`), msg('assistant', [{ type: 'text', text: long }]), ...ask(`second ${long}`), msg('assistant', [{ type: 'text', text: 'ok' }]), ...ask('third')]);
  assert.deepEqual(sent!.messages.map(m => m.content.slice(0, 6)), ['second', 'ok', 'third']);
  assert.match(sent!.chatOptions.systemPrompt, /The 2 earliest messages of this conversation are left out/);
});

test('chatjimmy refuses, before sending, a turn that cannot fit at all', async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response(''); }) as unknown as typeof fetch;
  await assert.rejects(run(ask('x'.repeat(40000))), /does not fit/);
  assert.equal(called, false);
});

test('chatjimmy reports an empty response as the window overflow it is', async () => {
  globalThis.fetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(run(ask('hi')), /empty response.*context window/);
});

// Session 1e7a936b: the tag written into the prose as well as around the call.
test('chatjimmy pairs a closing tag with the nearest opening one, so a tag in the prose is not the call', async () => {
  reply('It looks like the "about_matbot" tool can provide information about matbot. Let me call it with a<tool_call>\n'
    + 'to get a description of matbot.\n\n```\n<tool_call>\n{"name": "about_matbot", "arguments": {}}\n</tool_call>\n```\n\n'
    + 'This will return a description of matbot, and I can answer the user\'s question accordingly.');
  const evs = await run(ask('Tell me about matbot'));
  assert.deepEqual(calls(evs), [{ name: 'about_matbot', input: {}, truncated: undefined }]);
  assert.equal(textOf(evs), 'It looks like the "about_matbot" tool can provide information about matbot. Let me call it with a\n'
    + 'to get a description of matbot.');
});

test('chatjimmy strips the code fence a call is wrapped in', async () => {
  reply('Here\'s the tool call:\n\n```json\n<tool_call>\n{"name": "tool_search", "arguments": {"query": "matbot"}}\n</tool_call>\n```');
  const evs = await run(ask('Tell me about matbot'));
  assert.deepEqual(calls(evs).map(c => c.name), ['tool_search']);
  assert.equal(textOf(evs), 'Here\'s the tool call:');
});

test('chatjimmy keeps a fence that is not around a call', async () => {
  reply('Run this:\n```\nls -la\n```');
  const evs = await run(ask('how do I list files?'));
  assert.equal(textOf(evs), 'Run this:\n```\nls -la\n```');
});

test('chatjimmy logs only the cuts that changed something', async () => {
  reply('ok');
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: unknown) => { warned.push(String(m)); };
  try {
    await run([
      ...ask('do the thing'),
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'tool_search', input: {} }]),
      msg('tool', [{ type: 'tool-result', id: 'c1', result: 'short' }]),
    ], withTools, Array.from({ length: 6 }, (_, i) => bigTool(`tool_${i}`, 4000)));
  } finally { console.warn = warn; }
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /tool descriptions shortened/);
  assert.doesNotMatch(warned[0]!, /tool results shortened/, 'no result was long enough to be cut');
});

test('chatjimmy runs nothing from a tool listing the model writes instead of calling', async () => {
  reply('## Tool: matbot\n\nMatbot is a tool for managing matrices.\n\n<tools>\n'
    + '{"type":"function","function":{"name":"matbot_sum","description":"Add two matrices.","parameters":{"type":"object","properties":{"a":{"type":"string"}},"required":["a","b"]}}}\n'
    + '</tools>\n\nTo call matbot, wrap your request in <tool_call> tags.');
  const evs = await run(ask('Tell me about matbot'));
  assert.deepEqual(calls(evs), []);
});

test('chatjimmy reads no call out of a result the model imagines', async () => {
  reply('Searching.\n<tool_response>\n{"name": "matbot_info", "arguments": {}}\n</tool_response>\nDone.');
  const evs = await run(ask('Tell me about matbot'));
  assert.deepEqual(calls(evs), []);
});

test('chatjimmy does not take a schema for arguments', async () => {
  reply('{"name": "matbot_sum", "parameters": {"type": "object", "properties": {"a": {"type": "string"}}}}');
  const evs = await run(ask('add'));
  assert.deepEqual(calls(evs), []);
});

test('chatjimmy samples greedily when tools are offered, unless the profile says otherwise', async () => {
  reply('ok');
  const topK = () => (sent as unknown as { chatOptions: { topK: number } }).chatOptions.topK;
  await run(ask('hi'));
  assert.equal(topK(), 1);
  await run(ask('hi'), plain);
  assert.equal(topK(), 8, 'text-only keeps the old default');
  await run(ask('hi'), { ...withTools, parameters: { topK: 4 } });
  assert.equal(topK(), 4, 'the profile wins');
});
