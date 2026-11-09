import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, invokeTool, HookRegistry } from '@matatbread/matbot-core';
import type {
  Session, Store, Tool, ProviderAdapter, ProviderConfig, CompletionEvent, PipelineEvent, Principal,
  MatbotMachine, ToolEvent, ToolContext, ToolTypeIndex, Message,
} from '@matatbread/matbot-core';
import { createFunctionToolsPlugin } from '@matatbread/matbot-function-tools';
import { createToolTypesPlugin } from '@matatbread/matbot-tool-types';
import { createAlsPrincipalCarrier } from '@matatbread/matbot-host-node';
import { createAlsUsageCarrier } from '@matatbread/matbot-host-node';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

const principal: Principal = { id: 'tester', type: 'user' };

const FIB = 'fib(n: number): number { return n < 2 ? n : (await tool.fib({ n: n - 1 })) + (await tool.fib({ n: n - 2 })); }';

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

function machineWith(extra: Record<string, unknown> = {}): MatbotMachine & { hooks: HookRegistry } {
  const reg = new Map<string, Tool>();
  const data = new Map<string, Map<string, never>>();
  return Object.assign({
    tools: {
      list: () => [...reg.values()],
      resolve: (n: string) => reg.get(n) ?? null,
      register: (t: Tool) => { reg.set(t.name, t); },
      remove: (n: string) => { reg.delete(n); },
      removeByPlugin: () => {},
    },
    hooks: new HookRegistry(),
    TypeScriptStripper: { strip: (s: string) => stripTypeScriptTypes(s) },
    Notifier: { notify() {}, consume() {} },
    mounted: { observe() {} },
    systemContext: { register() {} },
    // function-tools keeps its permission lineage in its own settings.
    settings: (() => { const m = new Map<string, unknown>(); const s = { get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); }, entries: async () => Object.fromEntries(m) }; return () => s; })(),
    createStore: (ns: string) => {
      if (!data.has(ns)) data.set(ns, new Map());
      const docs = data.get(ns)!;
      return {
        get: async (id: string) => docs.get(id) ?? null,
        set: async (id: string, v: never) => { docs.set(id, v); },
        delete: async (id: string) => docs.delete(id),
        query: async () => ({ items: [...docs.values()], total: docs.size }),
      };
    },
  }, extra) as unknown as MatbotMachine & { hooks: HookRegistry };
}

type Call = { name: string; input: unknown } | { text: string };

/** Plays one scripted reply per provider call and records the tool names offered on each. */
function scripted(script: Call[][], offered: string[][]): ProviderAdapter {
  let n = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(_messages, _config, tools): AsyncIterable<CompletionEvent> {
      offered.push((tools ?? []).map(t => t.name));
      const reply = script[n++] ?? [{ text: 'done' }];
      return (async function* () {
        for (const [i, c] of reply.entries()) {
          if ('text' in c) yield { type: 'text-delta', delta: c.text };
          else yield { type: 'tool-call', id: `c${n}-${i}`, name: c.name, input: c.input };
        }
        yield { type: 'done' };
      })();
    },
  };
}

async function turn(machine: MatbotMachine & { hooks: HookRegistry }, store: Store<Session>, sessionId: string, script: Call[][]): Promise<{ offered: string[][]; events: PipelineEvent[] }> {
  const offered: string[][] = [];
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: scripted(script, offered), config }),
    tools: machine.tools,
    hooks: machine.hooks,
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
  });
  const view = await runner.open({ sessionId, signal: new AbortController().signal, content: [{ type: 'text', text: 'go' }], provider: 'fake', principal });
  const events: PipelineEvent[] = [];
  for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; }
  return { offered, events };
}

const ends = (events: PipelineEvent[]): Array<{ result: unknown; isError?: boolean }> =>
  events.flatMap(e => (e.type === 'tool:end' ? [{ result: e.result, ...(e.isError === true ? { isError: true } : {}) }] : []));

async function newSession(store: Store<Session>): Promise<Session> {
  const s = createSession();
  await store.set(s.id, s);
  return s;
}

import { sessionDataTool, sessionType, shapeOf, MAX_ENTRY_BYTES, SESSION_DATA_CREATOR } from '@matatbread/matbot-session-data';

// session_data keeps a value in its session as a marker and reads it back by id. The point is that a body
// can pass a tool's output on to a later step without the model ever reading it: so a write from a body has
// to reach the session (a nested call's marker), a read must be typed by what the entry holds, and a write is
// readable before the call that made it ends.

const ROWS = [{ day: '2026-11-01', size: 3 }, { day: '2026-11-02', size: 5 }];

async function typedMachine(): Promise<MatbotMachine & { hooks: HookRegistry }> {
  let index: ToolTypeIndex | undefined;
  const machine = machineWith({
    projectDir: join(import.meta.dirname, '..', '..', '..'),
    register: async (k: string, v: unknown) => { if (k === 'ToolTypeIndex') index = v as ToolTypeIndex; },
  });
  machine.tools.register({
    name: 'daily', description: 'daily counts', inputSchema: { type: 'object' },
    toolContract: 'ToolContract<{ day: string; size: number }[], Record<string, never>>',
    executor: { async *execute() { yield { type: 'result', value: ROWS }; } },
  } as Tool);
  machine.tools.register({
    name: 'chart', description: 'draws rows', inputSchema: { type: 'object' },
    toolContract: 'ToolContract<string, { rows: { day: string; size: number }[] }>',
    executor: { async *execute(p: unknown) { yield { type: 'result', value: `svg:${(p as { rows: unknown[] }).rows.length}` }; } },
  } as Tool);
  await createToolTypesPlugin().setup?.(machine);
  Object.assign(machine, { ToolTypeIndex: index });
  await createFunctionToolsPlugin().setup?.(machine);
  machine.tools.register(sessionDataTool as Tool);
  return machine;
}

const markersOf = (s: Session) => s.messages.filter((m: Message) => m.role === 'marker').flatMap(m => m.content)
  .flatMap(c => (c.type === 'marker' && c.creator === SESSION_DATA_CREATOR ? [c.data as { op: string; id: string; data?: unknown }] : []));

test('a body keeps a tool\'s output unread, and a later turn hands it on, typed by what it holds', { timeout: 120000 }, async () => {
  const machine = await typedMachine();
  const store = memStore();
  const s = await newSession(store);

  const first = await turn(machine, store, s.id, [[{ name: 'tool_function', input: { action: 'execute',
    definition: `{ const rows = await tool.daily({}); return await tool.session_data({ action: 'write', description: 'daily counts', data: rows }); }` } }]]);
  assert.ok(first.offered[0]!.includes('session_data'));
  const written = ends(first.events)[0]!.result as { id: string; shape: string; bytes: number };
  assert.equal(written.shape, '{ day: string; size: number }[]');
  assert.equal(written.bytes, JSON.stringify(ROWS).length);
  assert.ok(!JSON.stringify(written).includes('2026-11-01'), 'what the model reads back is the entry\'s description, not its data');
  assert.deepEqual(markersOf(store.docs.get(s.id)!).map(m => [m.op, m.id, m.data]), [['write', written.id, ROWS]]);

  const id = written.id;
  const second = await turn(machine, store, s.id, [
    [{ name: 'tool_function', input: { action: 'execute', definition: `{ const rows = await tool.session_data({ action: 'read', id: '${id}' }); return await tool.chart({ rows }); }` } }],
    // An id known only at run time reads `unknown`, which a typed consumer refuses until it is narrowed.
    [{ name: 'tool_function', input: { action: 'execute', definition: `{ const id: string = '${id}'; const rows = await tool.session_data({ action: 'read', id }); return await tool.chart({ rows }); }` } }],
    // Written and read in one call: the session does not show the write until the call ends.
    [{ name: 'tool_function', input: { action: 'execute', definition: `{ const w = await tool.session_data({ action: 'write', description: 'pair', data: [1, 2] }); return await tool.session_data({ action: 'read', id: w.id }); }` } }],
  ]);
  const results = ends(second.events);
  assert.equal(results[0]!.result, 'svg:2', JSON.stringify(results[0]));
  assert.equal(results[1]!.isError, true);
  assert.match(JSON.stringify(results[1]!.result), /TS2322/);
  assert.deepEqual(results[2]!.result, [1, 2]);
  assert.deepEqual(markersOf(store.docs.get(s.id)!).map(m => m.op), ['write', 'write']);
});

// A global function runs in sessions it cannot see: it may call session_data, and is checked as if nothing
// were held, so a read is `unknown` and must be narrowed. What fails is the read itself, in a session that
// does not hold the id.
test('a global function calls session_data, reads `unknown`, and fails at the read where the id is not held', { timeout: 120000 }, async () => {
  const machine = await typedMachine();
  const store = memStore();
  const s = await newSession(store);
  const first = await turn(machine, store, s.id, [[{ name: 'tool_function', input: { action: 'execute',
    definition: `{ return await tool.session_data({ action: 'write', description: 'daily counts', data: await tool.daily({}) }); }` } }]]);
  const id = (ends(first.events)[0]!.result as { id: string }).id;

  const r = await turn(machine, store, s.id, [
    [{ name: 'tool_function', input: { action: 'define',
      definition: 'countOf(id: string): number { const d = await tool.session_data({ action: \'read\', id }); return Array.isArray(d) ? d.length : 0; }' } }],
    // Typed only on a session's behalf: the same literal read, in a global function, is `unknown`.
    [{ name: 'tool_function', input: { action: 'define',
      definition: `chartIt(): string { const rows = await tool.session_data({ action: 'read', id: '${id}' }); return await tool.chart({ rows }); }` } }],
    [{ name: 'countOf', input: { id } }],
  ]);
  const results = ends(r.events);
  assert.match(JSON.stringify(results[0]!.result), /countOf/, JSON.stringify(results[0]));
  assert.notEqual(results[0]!.isError, true);
  assert.equal(results[1]!.isError, true);
  assert.match(JSON.stringify(results[1]!.result), /TS2322/);
  assert.equal(results[2]!.result, 2);

  const elsewhere = await turn(machine, store, (await newSession(store)).id, [[{ name: 'countOf', input: { id } }]]);
  assert.equal(ends(elsewhere.events)[0]!.isError, true);
  assert.match(JSON.stringify(ends(elsewhere.events)[0]!.result), /holds no entry/);
});

test('the description is the same however much is held; what a session holds is its type, by id', () => {
  const session = createSession();
  assert.equal(sessionType(session), undefined);
  session.messages.push({ id: 'm', role: 'marker', traceId: 't', createdAt: '', content: [{ type: 'marker', creator: SESSION_DATA_CREATOR,
    // The stored shape is not trusted: it is spliced into a check, so it is derived from the data again.
    data: { op: 'write', id: 'abcd2345', description: 'daily counts', shape: 'any', bytes: 20, createdAt: 'x', data: [{ day: 'a' }] } }] } as Message);
  assert.equal(sessionType(session), '{ "abcd2345": { day: string }[]; }');
  assert.doesNotMatch(sessionDataTool.description, /abcd2345/);
});

test('refusals: size, a door with no conversation, a stray property, a dropped or unknown id', async () => {
  const session = createSession();
  const run = async (input: unknown, on: Session = session): Promise<ToolEvent[]> => {
    const ctx = { callId: 'c', session: on, signal: new AbortController().signal } as unknown as ToolContext;
    const out: ToolEvent[] = [];
    for await (const ev of sessionDataTool.executor.execute(input, ctx)) out.push(ev);
    return out;
  };
  const last = (evs: ToolEvent[]) => evs.at(-1) as { type: string; message?: string; failure?: string; value?: unknown };

  const big = 'x'.repeat(MAX_ENTRY_BYTES);
  const tooBig = last(await run({ action: 'write', description: 'big', data: big }));
  assert.equal(tooBig.failure, 'invalid');
  assert.equal(tooBig.message, `This data is ${MAX_ENTRY_BYTES + 2} bytes and session_data holds at most ${MAX_ENTRY_BYTES}. Store the intermediate results using tools that accept data of ${MAX_ENTRY_BYTES + 2} bytes.`);
  assert.equal(last(await run({ action: 'write', description: 'fits', data: 'x'.repeat(MAX_ENTRY_BYTES - 2) })).type, 'result');

  assert.match(last(await run({ action: 'write', description: 'd', data: 1 }, { ...createSession(), id: '#http' })).message!, /not part of a conversation/);
  assert.match(last(await run({ action: 'write', description: 'd', data: 1, session_id: 'x' })).message!, /not "session_id"/);
  assert.match(last(await run({ action: 'write', data: 1 })).message!, /needs a "description"/);

  // In one call (this one session object): write, read, drop, read.
  const w = last(await run({ action: 'write', description: 'kept', data: { a: 1 } })).value as { id: string };
  assert.deepEqual(last(await run({ action: 'read', id: w.id })).value, { a: 1 });
  assert.deepEqual((last(await run({ action: 'list' })).value as { id: string }[]).map(e => e.id).includes(w.id), true);
  assert.deepEqual(last(await run({ action: 'drop', id: w.id })).value, { dropped: w.id });
  assert.match(last(await run({ action: 'read', id: w.id })).message!, /was dropped/);
  assert.match(last(await run({ action: 'read', id: 'nothere' })).message!, /holds no entry "nothere"\. It holds: /);
  // A new session object (the next call, or another conversation) does not see what this one wrote.
  assert.match(last(await run({ action: 'read', id: w.id }, createSession())).message!, /holds no entry/);
});

test('shapes are valid TypeScript for whatever JSON they are given', () => {
  assert.equal(shapeOf([{ day: 'a', size: 1 }, { day: 'b', size: 2, note: null }]), '{ day: string; size: number; note?: null }[]');
  assert.equal(shapeOf({}), 'Record<string, never>');
  assert.equal(shapeOf([]), 'unknown[]');
  assert.equal(shapeOf([1, 'a']), '(number | string)[]');
  assert.equal(shapeOf({ 'a-b': 1, ok: [true] }), '{ "a-b": number; ok: boolean[] }');
  assert.equal(shapeOf([1, 'a', true, null, [1]]), 'unknown[]', 'more than four kinds is not a type anyone can use');
  assert.equal(shapeOf([{ v: 1 }, { v: 'a' }]), '{ v: number | string }[]');
});
