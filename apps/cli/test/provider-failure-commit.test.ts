import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier } from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  PipelineEvent, Principal, MessageContent,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';
import { createAlsUsageCarrier } from '../src/usage-als.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// Nothing is written mid-turn: runSession commits once, at whichever terminal it reaches. So an exit that
// returns *without* committing discards the entire turn — and the failed-provider-call exit did. The
// multi-round case is exactly the tool-using one, so a provider 500 or a dropped connection on round 2
// threw away round 1's completed assistant message and tool result: work the frontend had already drawn,
// and which the next turn (which re-reads from the store) would then be missing.

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

const okTool: Tool = {
  name: 'ok',
  description: 'always succeeds',
  inputSchema: { type: 'object', properties: {} },
  executor: { async *execute() { yield { type: 'result', value: 'tool ran' }; } },
};

function toolRegistry(tool: Tool): ToolRegistry {
  return {
    register: () => { throw new Error('register unused'); },
    unregister: () => { throw new Error('unregister unused'); },
    resolve: (name: string) => (name === tool.name ? tool : null),
    list: () => [tool],
    has: (name: string) => name === tool.name,
  } as unknown as ToolRegistry;
}

// Round 1 asks for a tool and completes. Round 2 — the call that carries the tool result back — fails
// the way a real provider does: mid-stream, after the request was accepted.
function failsOnSecondCall(counter: { calls: number }): ProviderAdapter {
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const n = counter.calls++;
      return (async function* () {
        if (n > 0) {
          yield { type: 'text-delta', delta: 'partial' };
          throw new Error('upstream 500');
        }
        yield { type: 'text-delta', delta: 'calling the tool' };
        yield { type: 'tool-call', id: 'c1', name: 'ok', input: {} };
        yield { type: 'done' };
      })();
    },
  };
}

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

test('a provider failure mid-turn still commits the rounds that succeeded', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const counter = { calls: 0 };
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: failsOnSecondCall(counter), config }),
    tools: toolRegistry(okTool),
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
  });

  const view = await runner.open({
    sessionId: session.id, signal: new AbortController().signal,
    content: text('go'), provider: 'fake', principal,
  });
  const events: PipelineEvent[] = [];
  for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; }

  assert.equal(counter.calls, 2, 'round 1 completed, round 2 failed');

  const terminal = events.filter(e => e.type === 'done' || e.type === 'aborted' || e.type === 'error');
  assert.equal(terminal.length, 1, 'exactly one terminal');
  assert.equal(terminal[0]!.type, 'error', 'the failure still surfaces as an error');

  const saved = await store.get(session.id);
  assert.ok(saved, 'the session survives');
  assert.equal(saved.messages.filter(m => m.role === 'user').length, 1, 'the user turn is there');
  assert.equal(saved.messages.filter(m => m.role === 'assistant').length, 1, "round 1's assistant message is not lost");
  assert.equal(saved.messages.filter(m => m.role === 'tool').length, 1, "round 1's tool result is not lost");

  // The committed transcript must still be submittable: an unpaired tool_use is rejected outright by the
  // next request (Anthropic 400s), so losing the tool result would be worse than losing both.
  const calls   = new Set(saved.messages.flatMap(m => m.content.filter(c => c.type === 'tool-call').map(c => c.id)));
  const results = new Set(saved.messages.flatMap(m => m.content.filter(c => c.type === 'tool-result').map(c => c.id)));
  assert.deepEqual([...calls].filter(id => !results.has(id)), [], 'no unpaired tool_use');
});
