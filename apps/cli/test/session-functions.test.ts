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
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';
import { createAlsUsageCarrier } from '../src/usage-als.ts';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// A session-scoped function (`define { scope: 'session' }`) is stored as a marker in its session and offered
// to the model by a `screen` hook's turn-tool source — never registered. So it must be advertised and
// runnable in its own session, from the round after it was defined; callable by name from the session's
// other functions; and absent from every other session, from the registry, and from a sessionless call.

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

test('a session function is offered and callable from the next round, in its own session only, and never registered', { timeout: 20000 }, async () => {
  const machine = machineWith();
  await createFunctionToolsPlugin().setup?.(machine);
  const store = memStore();
  const mine  = await newSession(store);

  const first = await turn(machine, store, mine.id, [
    [{ name: 'tool_function', input: { action: 'define', scope: 'session', definition: FIB } }],
    [{ name: 'fib', input: { n: 10 } }],
    [{ name: 'tool_function', input: { action: 'lambda', definition: '(args: {}): number { return (await tool.fib({ n: 6 })) * 2; }' } }],
    [{ name: 'fib', input: { m: 3 } }],
  ]);
  assert.ok(!first.offered[0]!.includes('fib'), 'not offered before it was defined');
  assert.ok(first.offered[1]!.includes('fib'), 'offered from the very next round');
  const results = ends(first.events);
  assert.match(String((results[0]!.result as { message: string }).message), /Defined session function "fib"/);
  assert.equal(results[1]!.result, 55, 'recursion through `tool.fib` resolves the session function');
  assert.equal(results[2]!.result, 16, 'a lambda calls it by name');
  assert.equal(results[3]!.isError, true);
  assert.match(JSON.stringify(results[3]!.result), /unknown property \\"m\\"; missing required property \\"n\\"/);
  assert.equal(machine.tools.resolve('fib'), null, 'never in the registry');

  // Persisted as a marker in its own session …
  const stored = store.docs.get(mine.id)!;
  const markers = stored.messages.filter((m: Message) => m.role === 'marker').flatMap(m => m.content);
  assert.deepEqual(markers.map(c => c.type === 'marker' ? [c.creator, (c.data as { op: string }).op] : null),
    [['@matatbread/matbot-function-tools', 'define']]);

  // … so a later turn of this session is offered it from round one, and another session never is.
  const later = await turn(machine, store, mine.id, [[{ name: 'fib', input: { n: 7 } }]]);
  assert.ok(later.offered[0]!.includes('fib'));
  assert.equal(ends(later.events)[0]!.result, 13);
  const other = await turn(machine, store, (await newSession(store)).id, [[{ name: 'fib', input: { n: 7 } }]]);
  assert.ok(!other.offered[0]!.includes('fib'));
  assert.match(JSON.stringify(ends(other.events)[0]!.result), /Unknown tool: fib/);

  // A sessionless door — `POST /tools/:name` is invokeTool with no turn behind it — cannot reach it.
  assert.throws(() => invokeTool(machine, 'fib', { n: 1 }, { session: stored, signal: new AbortController().signal }), /not registered/);
});

test('a session function cannot shadow a global tool, at definition or after', { timeout: 20000 }, async () => {
  const machine = machineWith();
  await createFunctionToolsPlugin().setup?.(machine);
  const global: Tool = { name: 'sq', description: 'global', inputSchema: { type: 'object' }, executor: { async *execute() { yield { type: 'result', value: 'global' }; } } };
  machine.tools.register(global);
  const store = memStore();
  const s = await newSession(store);

  const refused = await turn(machine, store, s.id, [[{ name: 'tool_function', input: { action: 'define', scope: 'session', definition: 'sq(n: number): number { return n * n; }' } }]]);
  assert.match(JSON.stringify(ends(refused.events)[0]!.result),
    /The tool sq can't be added to this turn as it would shadow the global tool with the same name. Pick a unique name/);

  // Defined while free; a global tool then takes the name. The session one is withheld and the model told.
  machine.tools.remove('sq');
  await turn(machine, store, s.id, [[{ name: 'tool_function', input: { action: 'define', scope: 'session', definition: 'sq(n: number): number { return n * n; }' } }]]);
  machine.tools.register(global);
  const screened = await machine.hooks.runScreen({ session: store.docs.get(s.id)!, config: { provider: 'fake' }, signal: new AbortController().signal });
  assert.match(JSON.stringify(screened.ephemeral), /The tool sq can't be added to this turn/);
  assert.deepEqual((await screened.tools[0]!(store.docs.get(s.id)!)).map(t => t.name), [], 'withheld, so the runner never has to drop it');
  const after = await turn(machine, store, s.id, [[{ name: 'sq', input: { n: 3 } }]]);
  assert.equal(ends(after.events)[0]!.result, 'global', 'the global tool keeps its name');
});

test('promoting to global retires the session function; remove retires one too', { timeout: 20000 }, async () => {
  const machine = machineWith();
  await createFunctionToolsPlugin().setup?.(machine);
  const store = memStore();
  const s = await newSession(store);

  await turn(machine, store, s.id, [
    [{ name: 'tool_function', input: { action: 'define', scope: 'session', definition: 'half(n: number): number { return n / 2; }' } }],
    [{ name: 'tool_function', input: { action: 'define', scope: 'session', definition: 'third(n: number): number { return n / 3; }' } }],
    [{ name: 'tool_function', input: { action: 'define', definition: 'half(n: number): number { return n / 2; }' } }],
    [{ name: 'tool_function', input: { action: 'remove', name: 'third' } }],
    [{ name: 'tool_function', input: { action: 'list' } }],
  ]);
  assert.ok(machine.tools.resolve('half'), 'promoted into the registry');
  const listed = await turn(machine, store, s.id, [[{ name: 'tool_function', input: { action: 'list' } }]]);
  const value = ends(listed.events)[0]!.result as { functions: { name: string }[]; sessionFunctions: { name: string }[] };
  assert.deepEqual(value.functions.map(f => f.name), ['half']);
  assert.deepEqual(value.sessionFunctions, [], 'both retired by marker');
});

test('session functions type-check like registered tools, and a global function may not call one', { timeout: 60000 }, async () => {
  let index: ToolTypeIndex | undefined;
  const machine = machineWith({
    configPath: join(import.meta.dirname, '..', '..', '..', 'matbot.yaml'),
    register: async (k: string, v: unknown) => { if (k === 'ToolTypeIndex') index = v as ToolTypeIndex; },
  });
  await createToolTypesPlugin().setup?.(machine);
  Object.assign(machine, { ToolTypeIndex: index });
  await createFunctionToolsPlugin().setup?.(machine);
  const fn = machine.tools.resolve('tool_function')!;

  const session = createSession();
  const call = async (input: unknown, turnTools?: ReadonlyMap<string, Tool>): Promise<ToolEvent[]> => {
    const ctx = { callId: 'c', session, signal: new AbortController().signal, prompt: async () => { throw new Error('no'); },
      ...(turnTools !== undefined ? { turnTools } : {}) } as unknown as ToolContext;
    const out: ToolEvent[] = [];
    for await (const ev of fn.executor.execute(input, ctx)) out.push(ev);
    return out;
  };

  const defined = await call({ action: 'define', scope: 'session', definition: FIB });
  assert.equal(defined.at(-1)?.type, 'result', JSON.stringify(defined.at(-1)));
  assert.deepEqual(defined[0], { type: 'marker', creator: '@matatbread/matbot-function-tools',
    data: { op: 'define', name: 'fib', definition: FIB } }, 'checked: recursion types against its own contract, and no definedUnchecked');

  // What the runner would hand the next round: the tool built from that marker.
  session.messages.push({ id: 'm', role: 'marker', traceId: 't', createdAt: '', content: [defined[0] as never] } as Message);
  const screened = await machine.hooks.runScreen({ session, config: { provider: 'fake' }, signal: new AbortController().signal });
  const turnTools = new Map((await screened.tools[0]!(session)).map(t => [t.name, t]));
  assert.equal(turnTools.get('fib')?.toolContract, 'ToolContract<number, { n: number }>');

  const good = await call({ action: 'lambda', definition: '(args: {}): number { return await tool.fib({ n: 5 }); }' }, turnTools);
  assert.deepEqual(good.at(-1), { type: 'result', value: 5 });
  const wrongUse = await call({ action: 'lambda', definition: '(args: {}): string { return (await tool.fib({ n: 5 })).toUpperCase(); }' }, turnTools);
  assert.match(String((wrongUse.at(-1) as { message?: string }).message), /TS2339/);
  const noTurn = await call({ action: 'lambda', definition: '(args: {}): number { return await tool.fib({ n: 5 }); }' });
  assert.equal(noTurn.at(-1)?.type, 'error', 'no turn tools ⇒ not callable, and the check says so');

  const types = await call({ action: 'types' }, turnTools);
  assert.match(String((types.at(-1) as { value: { dts: string } }).value.dts), /"fib": import\('@matatbread\/matbot-plugin-api'\)\.ToolContract<number, \{ n: number \}>/);

  const global = await call({ action: 'define', definition: 'twice(n: number): number { return 2 * await tool.fib({ n }); }' }, turnTools);
  const message = String((global.at(-1) as { message?: string }).message);
  assert.match(message, /HINT: "fib" is a session function/);
  assert.equal(machine.tools.resolve('twice'), null);

  const checked = await call({ action: 'check' }, turnTools);
  const rows = (checked.at(-1) as { value: { results: { name: string; session?: true; ok: boolean }[] } }).value.results;
  assert.deepEqual(rows.filter(r => r.session).map(r => [r.name, r.ok]), [['fib', true]]);
  // Stranded (a split took the helper it calls): the same check fails it.
  const stranded = await call({ action: 'define', scope: 'session', definition: 'fib2(n: number): number { return await tool.fib({ n }); }' }, turnTools);
  session.messages.push({ id: 'm2', role: 'marker', traceId: 't', createdAt: '', content: [stranded[0] as never] } as Message);
  session.messages.splice(0, 1);   // the `fib` marker went with the other half of a split
  const after = await call({ action: 'check', name: 'fib2' }, new Map([...turnTools].filter(([n]) => n !== 'fib')));
  assert.equal((after.at(-1) as { value: { ok: boolean } }).value.ok, false);

});
