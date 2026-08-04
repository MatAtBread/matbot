import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier,
  HookRegistry, isTruncatedToolResult,
} from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  PipelineEvent, Principal, MessageContent,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// A tool call whose arguments were severed mid-stream (the response hit its token limit part-way
// through). The adapter used to throw, ending the turn with a dead-end error. It is now surfaced as a
// tool-call carrying `truncated`, which the runner answers with an error result instead of executing —
// so the model self-corrects on the next round through the loop's ordinary machinery.
//
// Separately: a response cut short with no tool call in it at all (the commoner case — prose stopping
// mid-sentence) is recorded as a `matbot-truncation` marker, which is LLM-invisible.

const principal: Principal = { id: 'tester', type: 'user' };

function memStore(seed: Session): Store<Session> {
  const m = new Map<string, Session>([[seed.id, seed]]);
  return {
    get: async id => m.get(id) ?? null,
    set: async (id, v) => { m.set(id, v); },
    cas: async () => { throw new Error('cas unused'); },
    delete: async () => { throw new Error('delete unused'); },
    query: async () => { throw new Error('query unused'); },
  };
}

let executed = 0;
const editTool: Tool = {
  name: 'patch_file',
  description: 'edits a file',
  inputSchema: { type: 'object', properties: {} },
  executor: { async *execute() { executed += 1; yield { type: 'result', value: 'edited' }; } },
};

function toolRegistry(tool: Tool): ToolRegistry {
  return {
    register: () => { throw new Error('register unused'); },
    unregister: () => { throw new Error('unregister unused'); },
    resolve: name => (name === tool.name ? tool : null),
    list: () => [tool],
    has: name => name === tool.name,
  } as unknown as ToolRegistry;
}

// Round 1: a call cut off mid-arguments. Round 2: plain text, done.
function truncatingProvider(): ProviderAdapter {
  let call = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const n = call++;
      return (async function* () {
        if (n === 0) {
          yield { type: 'text-delta', delta: 'editing now' };
          yield { type: 'tool-call', id: 'c1', name: 'patch_file', input: {},
                  truncated: { bytes: 8192, stopReason: 'max_tokens' } };
          yield { type: 'truncated', reason: 'max-tokens', raw: 'max_tokens' };
        } else {
          yield { type: 'text-delta', delta: 'ok, doing it in pieces' };
        }
        yield { type: 'done' };
      })();
    },
  };
}

function makeRunner(store: Store<Session>, adapter: ProviderAdapter, hooks?: HookRegistry) {
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  return createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config }),
    tools: toolRegistry(editTool),
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
    ...(hooks !== undefined ? { hooks } : {}),
  });
}

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

async function run(runner: ReturnType<typeof makeRunner>, sid: string): Promise<PipelineEvent[]> {
  const view = await runner.open({
    sessionId: sid, signal: new AbortController().signal,
    content: text('edit the file'), provider: 'fake', principal,
  });
  const events: PipelineEvent[] = [];
  for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; }
  return events;
}

test('a severed tool call is answered, not executed, and the turn survives', { timeout: 15000 }, async () => {
  executed = 0;
  const session = createSession();
  const store   = memStore(session);
  const events  = await run(makeRunner(store, truncatingProvider()), session.id);

  // The turn completes normally rather than dying on a thrown adapter error.
  assert.ok(events.some(e => e.type === 'done'), 'turn ended with done');
  assert.ok(!events.some(e => e.type === 'error'), 'no error event');
  assert.equal(executed, 0, 'the severed call must never reach the executor');

  const saved   = await store.get(session.id);
  const results = saved!.messages.flatMap(m => m.content).filter(c => c.type === 'tool-result');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, true);
  assert.ok(isTruncatedToolResult(results[0]!.result), 'result is recognisable as a truncation');
  const r = results[0]!.result as { truncated: { tool: string; bytes: number; stopReason?: string } };
  assert.equal(r.truncated.tool, 'patch_file');
  assert.equal(r.truncated.bytes, 8192);
  assert.equal(r.truncated.stopReason, 'max_tokens');

  // Pairing holds, so the next submission is valid.
  const calls = new Set(saved!.messages.flatMap(m => m.content.filter(c => c.type === 'tool-call').map(c => c.id)));
  const ids   = new Set(results.map(c => c.id));
  assert.deepEqual([...calls].filter(id => !ids.has(id)), [], 'no unpaired tool_use');

  // The model got another round and finished.
  assert.ok(saved!.messages.some(m => m.content.some(c => c.type === 'text' && c.text.includes('in pieces'))));
});

test('a toolresult hook can fold in tool-specific advice', { timeout: 15000 }, async () => {
  executed = 0;
  const session = createSession();
  const store   = memStore(session);

  // What a consumer would write: the harness cannot know that THIS tool has a cheaper line-range mode.
  const hooks = new HookRegistry();
  hooks.register({
    on: 'toolresult',
    handler: ctx => {
      if (!isTruncatedToolResult(ctx.result)) return;
      if (ctx.result.truncated.tool !== 'patch_file') return;
      return { result: { ...ctx.result,
        error: `${ctx.result.error} For a large edit pass start_line/end_line instead of a whole-file search/replace.` } };
    },
  });

  await run(makeRunner(store, truncatingProvider(), hooks), session.id);

  const saved  = await store.get(session.id);
  const result = saved!.messages.flatMap(m => m.content)
    .find(c => c.type === 'tool-result')!.result as { error: string };
  assert.match(result.error, /start_line\/end_line/, 'hook advice reached the persisted result');
  assert.match(result.error, /cut off after 8192 bytes/, 'and the core message survived it');
});

test('a response cut short is recorded as an LLM-invisible marker', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);

  // No tool call at all — the common case: prose that stops mid-sentence.
  const proseOnly: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      return (async function* () {
        yield { type: 'text-delta', delta: 'the answer is roughly forty-t' };
        yield { type: 'truncated', reason: 'max-tokens', raw: 'max_tokens' };
        yield { type: 'done' };
      })();
    },
  };

  const events = await run(makeRunner(store, proseOnly), session.id);

  const saved  = await store.get(session.id);
  const marker = saved!.messages.find(m => m.role === 'marker');
  assert.ok(marker, 'a marker message was persisted');
  const block = marker!.content[0] as { type: 'marker'; creator: string; data: { reason: string; raw?: string } };
  assert.equal(block.creator, 'matbot-truncation');
  assert.equal(block.data.reason, 'max-tokens');
  assert.equal(block.data.raw, 'max_tokens');

  // Carried live too, so a frontend draws it without waiting for a reload.
  assert.ok(events.some(e => e.type === 'marker'), 'marker emitted live');

  // Marker role ⇒ elided from every provider submission, so the model is never told it was cut off.
  assert.equal(marker!.role, 'marker');
});
