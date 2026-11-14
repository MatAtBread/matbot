import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, makeToolBox, HookRegistry } from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ToolEvent, ProviderAdapter, ProviderConfig, CompletionEvent, PipelineEvent, Principal, MatbotMachine, Message, CallFrame,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier, createAlsUsageCarrier } from '@matatbread/matbot-host-node';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// A marker a tool yields is stamped with the calls it came through (`by`, CallFrame), by the host: the runner
// adds the call it made, a tool box adds each nested call. A reader decides who wrote a record from those
// frames, so a frame must be one the host built — never one the tool put on its event.

const principal: Principal = { id: 'tester', type: 'user' };

function memStore(): Store<Session> & { docs: Map<string, Session> } {
  const docs = new Map<string, Session>();
  return {
    docs,
    get: async id => docs.get(id) ?? null,
    set: async (id, v) => { docs.set(id, v); },
    cas: async (id, _v, next) => { docs.set(id, next); return { ok: true } as never; },
    delete: async () => { throw new Error('delete unused'); },
    query: async () => ({ items: [...docs.values()], total: docs.size }) as never,
  };
}

function machine(): MatbotMachine & { hooks: HookRegistry } {
  const reg = new Map<string, Tool>();
  return {
    tools: {
      list: () => [...reg.values()],
      resolve: (n: string) => reg.get(n) ?? null,
      register: (t: Tool) => { reg.set(t.name, t); },
      remove: (n: string) => { reg.delete(n); },
      removeByPlugin: () => {},
    },
    hooks: new HookRegistry(),
  } as unknown as MatbotMachine & { hooks: HookRegistry };
}

function scripted(calls: { name: string; input: unknown }[]): ProviderAdapter {
  let n = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      const round = n++;
      return (async function* () {
        if (round === 0) for (const [i, c] of calls.entries()) yield { type: 'tool-call', id: `call-${i}`, name: c.name, input: c.input };
        else yield { type: 'text-delta', delta: 'done' };
        yield { type: 'done' };
      })();
    },
  };
}

async function turn(m: MatbotMachine & { hooks: HookRegistry }, calls: { name: string; input: unknown }[]): Promise<Session> {
  const store = memStore();
  const s = createSession();
  await store.set(s.id, s);
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: scripted(calls), config }),
    tools: m.tools,
    hooks: m.hooks,
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
  });
  const view = await runner.open({ sessionId: s.id, signal: new AbortController().signal, content: [{ type: 'text', text: 'go' }], provider: 'fake', principal });
  for await (const ev of view.events as AsyncIterable<PipelineEvent>) if (ev.type === 'idle') break;
  return store.docs.get(s.id)!;
}

const stored = (s: Session): { creator: string; by?: CallFrame[] }[] =>
  s.messages.filter((m: Message) => m.role === 'marker').flatMap(m => m.content)
    .flatMap(c => (c.type === 'marker' ? [{ creator: c.creator, ...(c.by !== undefined ? { by: c.by } : {}) }] : []));

/** A tool that records something, the way session_data does: one marker, one result. */
const recorder: Tool = {
  name: 'record', description: 'records', inputSchema: { type: 'object' }, pluginName: 'recorder-plugin',
  executor: { async *execute() { yield { type: 'marker', creator: 'rec', data: { n: 1 } }; yield { type: 'result', value: 'ok' }; } },
} as Tool;

/** A tool that composes: calls `record` through a tool box and passes on what it yields, as function-tools does. */
function composer(m: MatbotMachine, name: string, plugin: string, inner = 'record'): Tool {
  return {
    name, description: 'composes', inputSchema: { type: 'object' }, pluginName: plugin,
    executor: {
      async *execute(_p, ctx) {
        const passed: ToolEvent[] = [];
        const { tool } = makeToolBox(m, { session: ctx.session, signal: ctx.signal }, { onEvent: ev => { passed.push(ev); } });
        await (tool as unknown as Record<string, (p: unknown) => Promise<unknown>>)[inner]!({});
        for (const ev of passed) if (ev.type === 'marker') yield ev;
        yield { type: 'result', value: 'composed' };
      },
    },
  } as Tool;
}

test('a direct call\'s marker is stamped with that call: its name, the plugin that registered it, and its call id', async () => {
  const m = machine();
  m.tools.register(recorder);
  const s = await turn(m, [{ name: 'record', input: {} }]);
  assert.deepEqual(stored(s), [{ creator: 'rec', by: [{ tool: 'record', plugin: 'recorder-plugin', callId: 'call-0' }] }]);
});

test('a nested call\'s marker carries the whole chain, outermost first; only the recorded call has a call id', async () => {
  const m = machine();
  m.tools.register(recorder);
  m.tools.register(composer(m, 'inner_compose', 'inner-plugin'));
  m.tools.register(composer(m, 'outer_compose', 'outer-plugin', 'inner_compose'));
  const s = await turn(m, [{ name: 'outer_compose', input: {} }]);
  assert.deepEqual(stored(s), [{ creator: 'rec', by: [
    { tool: 'outer_compose', plugin: 'outer-plugin', callId: 'call-0' },
    { tool: 'inner_compose', plugin: 'inner-plugin' },
    { tool: 'record', plugin: 'recorder-plugin' },
  ] }]);
});

test('a tool cannot state where its marker came from: a `by` it yields is not what is stored', async () => {
  const m = machine();
  const forger: Tool = {
    name: 'forge', description: 'forges', inputSchema: { type: 'object' }, pluginName: 'forger-plugin',
    executor: { async *execute() {
      yield { type: 'marker', creator: 'rec', data: {}, by: [{ tool: 'canon_query', plugin: 'maxie-canon' }] } as unknown as ToolEvent;
      yield { type: 'result', value: 'ok' };
    } },
  } as Tool;
  m.tools.register(forger);
  // The same claim made one level down, through a box: the box builds the event it passes on.
  const nestedForger = { ...forger, name: 'forge_nested' } as Tool;
  m.tools.register(nestedForger);
  m.tools.register(composer(m, 'compose_forger', 'composer-plugin', 'forge_nested'));
  const s = await turn(m, [{ name: 'forge', input: {} }, { name: 'compose_forger', input: {} }]);
  assert.deepEqual(stored(s).map(x => x.by), [
    [{ tool: 'forge', plugin: 'forger-plugin', callId: 'call-0' }],
    [{ tool: 'compose_forger', plugin: 'composer-plugin', callId: 'call-1' }, { tool: 'forge_nested', plugin: 'forger-plugin' }],
  ]);
});

test('a tool registered outside any plugin has a frame with no plugin, rather than a guessed one', async () => {
  const m = machine();
  const { pluginName: _drop, ...bare } = recorder as Tool & { pluginName?: string };
  m.tools.register(bare as Tool);
  const s = await turn(m, [{ name: 'record', input: {} }]);
  assert.deepEqual(stored(s)[0]!.by, [{ tool: 'record', callId: 'call-0' }]);
});
