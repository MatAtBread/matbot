import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, HookRegistry,
  recordUsage, withUsageScope,
} from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent,
  PipelineEvent, Principal, MessageContent, UsageRecord,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// Usage attribution is DECLARED by the producer, never inferred from when a record lands. The runner
// used to slice the turn's sink by index — mark the length before a tool, take everything appended
// after it — which credits a tool with any completion that merely *resolved* while it ran. The triggers
// plugin does exactly that: its classifier is kicked off detached inside a `screen` hook and settles at
// an arbitrary later moment, so whose spend it became was decided by a race.

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

function toolRegistry(tool: Tool): ToolRegistry {
  return {
    register: () => { throw new Error('register unused'); },
    unregister: () => { throw new Error('unregister unused'); },
    resolve: name => (name === tool.name ? tool : null),
    list: () => [tool],
    has: name => name === tool.name,
  } as unknown as ToolRegistry;
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// Runs long enough that the detached hook completion lands mid-execution, and books its own spend.
const slowTool: Tool = {
  name: 'slow',
  description: 'takes a while and runs a completion of its own',
  inputSchema: { type: 'object', properties: {} },
  executor: {
    async *execute() {
      await wait(120);
      recordUsage('tool-provider', { inputTokens: 100, outputTokens: 50 });
      yield { type: 'result', value: 'ok' };
    },
  },
};

// One tool call, then a plain answer on the next round.
function callsToolOnce(): ProviderAdapter {
  let n = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const first = n++ === 0;
      return (async function* () {
        if (first) yield { type: 'tool-call', id: 'call-1', name: 'slow', input: {} };
        else       yield { type: 'text-delta', delta: 'done' };
        yield { type: 'done' };
      })();
    },
  };
}

const text = (t: string): MessageContent[] => [{ type: 'text', text: t }];

test('a detached hook completion is not credited to whichever tool was running', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);

  // Mirrors the triggers classifier: started inside the screen hook, deliberately NOT awaited, and
  // settling ~120ms before the tool it overlaps finishes.
  let classified: Promise<void> | undefined;
  const hooks = new HookRegistry();
  hooks.register({
    on: 'screen',
    pluginName: 'triggers-like',
    handler: () => {
      classified = wait(20).then(() => { recordUsage('classifier', { inputTokens: 7, outputTokens: 3 }); });
      return undefined;
    },
  });

  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: callsToolOnce(), config }),
    tools: toolRegistry(slowTool),
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
    hooks,
  });

  const view = await runner.open({
    sessionId: session.id, signal: new AbortController().signal,
    content: text('go'), provider: 'fake', principal,
  });
  const events: PipelineEvent[] = [];
  for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; }
  await classified;

  const saved  = await store.get(session.id);
  const result = saved!.messages
    .flatMap(m => m.content)
    .find(c => c.type === 'tool-result' && c.id === 'call-1');
  assert.ok(result && result.type === 'tool-result', 'the tool ran');

  const usage: UsageRecord[] = result.usage ?? [];
  assert.deepEqual(usage.map(u => u.provider), ['tool-provider'],
    'only the tool\'s own completion — the classifier resolved mid-call but belongs to the screen hook');
  assert.deepEqual(usage[0]!.site, { kind: 'tool', callId: 'call-1', tool: 'slow' },
    'the record carries the site that produced it');
});

test('a nested usage scope rolls up into its parent', async () => {
  let inner: UsageRecord[] = [];
  const outer = await withUsageScope(async parent => {
    recordUsage('outer-provider', { inputTokens: 1, outputTokens: 1 });
    await withUsageScope(async child => {
      recordUsage('inner-provider', { inputTokens: 2, outputTokens: 2 });
      inner = child.entries;
    });
    return parent.entries;
  });

  assert.deepEqual(inner.map(u => u.provider), ['inner-provider'],
    'a sub-turn can be asked what it alone cost');
  assert.deepEqual(outer.map(u => u.provider), ['outer-provider', 'inner-provider'],
    'and its spend does not vanish from the turn containing it');
});
