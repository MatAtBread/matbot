import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { parsePackage, buildPackageFn, exportFn, runFunction, createFunctionToolsPlugin } from '@matatbread/matbot-function-tools';
import { createToolTypesPlugin } from '@matatbread/matbot-tool-types';
import type { MatbotMachine, Store, Tool, ToolContext, ToolEvent, ToolTypeIndex } from '@matatbread/matbot-plugin-api';

// A tool_function PACKAGE (#63): one TypeScript module whose exported functions become tools named
// `<package>__<function>`, and whose other declarations are private — never registered, so never in the
// bounded tool window competing with the exports that use them.

const stripper = { strip: (s: string) => stripTypeScriptTypes(s) };

const PRESENCE = `
interface Report { home: boolean; room?: string }

// Called by both exports — the helper this whole feature exists for. It's not a tool.
async function report(): Promise<Report> {
  const r = await tool.presence_sensor({});
  return r as Report;
}

/** Whether Mat is at home, in one word. */
export async function where(args: {}): Promise<string> {
  return (await report()).home ? 'home' : 'out';
}

// The room Mat was last seen in.
export async function room(args: { fallback?: string }): Promise<string> {
  const note = "export function decoy(): void {}";   // an export in a string is not an export
  return (await report()).room ?? args.fallback ?? 'unknown';
}
`;

test('exports become tools; everything else stays private', () => {
  const { exports } = parsePackage('Presence', PRESENCE);
  assert.deepEqual(exports.map(e => e.toolName), ['Presence__where', 'Presence__room']);
  assert.equal(exports[0]?.description, 'Whether Mat is at home, in one word.');
  assert.equal(exports[1]?.description, 'The room Mat was last seen in.');
  assert.equal(exports[0]?.toolContract, 'ToolContract<string, {}>');
  assert.equal(exports[1]?.toolContract, 'ToolContract<string, { fallback?: string }>');
  assert.deepEqual(exports[1]?.inputSchema, { type: 'object', properties: { fallback: { type: 'string' } } });
});

test('a brace-bearing return type is not mistaken for the body', () => {
  const { exports } = parsePackage('P', `export function a(args: {}): { n: number } { return { n: 1 }; }\nexport function b(args: {}): { n: number }[] { return []; }`);
  assert.deepEqual(exports.map(e => [e.name, e.resultType]), [['a', '{ n: number }'], ['b', '{ n: number }[]']]);
});

test('malformed packages are refused with the reason', () => {
  const cases: [string, string, RegExp][] = [
    ['A__B', 'export function f(a: {}): void {}',                   /package name/],
    ['A_',   'export function f(a: {}): void {}',                   /package name/],
    ['P',    'function f(a: {}): void {}',                          /at least one function/],
    ['P',    'export const x = 1;',                                 /only functions can be exported/],
    ['P',    'export interface X { a: string }',                    /only functions can be exported/],
    ['P',    'export function f(a: string, b: string): void {}',    /ONE object parameter/],
    ['P',    'export function f(a: string): void {}',               /must be an object/],
    ['P',    'export function f(a: {}) {}',                         /return type/],
    ['P',    'export function _f(a: {}): void {}',                  /start with a letter/],
    ['P',    'export function f(a: {}): void {}\nexport function f(a: {}): void {}', /exported twice/],
    ['P'.repeat(40), `export function ${'f'.repeat(30)}(a: {}): void {}`, /longer than 64/],
    // The <T> is what fails, not the export being a function.
    ['P',    'export function f<T>(a: { v: T }): T { return a.v; }', /"f" is generic/],
  ];
  for (const [name, src, re] of cases) assert.throws(() => parsePackage(name, src), re, `${name}: ${src}`);
});

function fakeMachine(tools: Tool[] = []): MatbotMachine {
  const reg = new Map(tools.map(t => [t.name, t]));
  return {
    tools: {
      list: () => [...reg.values()],
      resolve: (n: string) => reg.get(n) ?? null,
      register: (t: Tool) => { reg.set(t.name, t); },
      remove: (n: string) => reg.delete(n),
    },
  } as unknown as MatbotMachine;
}

const ctx = {
  callId: 'c1', session: { id: 's1' }, signal: new AbortController().signal,
  prompt: () => Promise.reject(new Error('non-interactive')),
} as unknown as ToolContext;

const sensor = (value: unknown): Tool => ({
  name: 'presence_sensor', description: '', inputSchema: { type: 'object' },
  executor: { async *execute() { yield { type: 'result', value }; } },
});

async function run(machine: MatbotMachine, name: string, input: unknown): Promise<ToolEvent[]> {
  const t = machine.tools.resolve(name);
  assert.ok(t, `${name} should be registered`);
  const events: ToolEvent[] = [];
  for await (const ev of t.executor.execute(input, ctx)) events.push(ev);
  return events;
}

test('an export calls a private helper, which calls a registered tool', async () => {
  const machine = fakeMachine([sensor({ home: true, room: 'kitchen' })]);
  const parsed = parsePackage('Presence', PRESENCE);
  const pkg = await buildPackageFn(stripper, PRESENCE, parsed);
  const events: ToolEvent[] = [];
  for await (const ev of runFunction(machine, ctx, exportFn(pkg, 'room'), [{}])) events.push(ev);
  assert.deepEqual(events.at(-1), { type: 'result', value: 'kitchen' });
});

test('top-level forms that would behave differently if run once are refused, naming plugins', () => {
  const refused: [string, RegExp][] = [
    ['let n = 0;',                                  /top-level `let`/],
    ['var n;',                                      /top-level `var`/],
    ['class Box { static cache = new Map() }',      /`class` invites instance or static state/],
    ['abstract class Base {}',                      /`class` invites instance or static state/],
    ['declare const x: number;',                    /ReferenceError/],
    ['enum Mode { A, B }',                          /not erasable/],
    ['function* gen() {}\nlet y = 1;',              /top-level `let`/],
    ['const a = 1;\nn++;',                          /top-level statement `n\+\+;`/],
    ['const a = { b: 1 }\nconsole.log(a)',          /top-level statement `console\.log\(a\)`/],
    ['function f(): void {}\nfor (;;) {}',          /top-level statement `for/],
    ['await tool.x({});',                           /top-level statement/],
    ['const cfg = await tool.x({});',               /top-level `await`/],
    ["import { x } from 'y';",                      /cannot `import`/],
    ['(async () => { })();',                        /top-level statement/],
    // No semicolons: a statement start is where the previous declaration ENDS, not after `;`.
    ['const LIMIT = 10\nlet count = 0',              /top-level `let`/],
    ['type A = Array<string>\nlet count = 0',       /top-level `let`/],
    ['const d = b!\nnew Date()',                    /top-level statement `new Date\(\)`/],
    // A line opening with `(` after a function or interface body is a new statement, not a call.
    ['function f(): void {}\n(async () => { })()',  /top-level statement `\(async/],
    ['interface I { a: number }\n(async () => { })()', /top-level statement `\(async/],
    ['function over(a: string): void;\nfunction over(a: string): void {}\nlet z = 1', /top-level `let`/],
  ];
  for (const [top, re] of refused) {
    const src = `${top}\nexport async function f(args: {}): Promise<void> {}`;
    assert.throws(() => parsePackage('P', src), re, top);
    assert.throws(() => parsePackage('P', src), /matbot plugin, not a package/, top);
  }

  const allowed = [
    '// let n = 0; is only prose here\nconst LIMIT = 5;   // "var" in a string: \'let x\'',
    'const f = async (a: number) => await Promise.resolve(a);',
    "type Mode =\n  | 'a'\n  | 'b';",
    'const xs = [1, 2]\n  .map(n => n * 2);',
    'const o = {\n  a: 1,\n}\ninterface I { a: number }',
    'async function helper(): Promise<number> { let n = 0; await tool.x({}); return n; }',
    'function sync(a: number): number { return a; }',
    'export function syncExport(args: { a: number }): number { return args.a; }',
    'const n = 1\n  + 2',
    'const big = 10 as\n  number',
    'type Pair<T> = [T, T]\ntype Box = { v: Pair<number> }',
    'function over(a: string): void;\nfunction over(a: string): void {}',
    'function g<T extends { a: 1 }>(x: T): T { return x; }',
    'const count: Map<string, number> = new Map()',
  ];
  for (const top of allowed) {
    assert.doesNotThrow(() => parsePackage('P', `${top}\nexport async function f(args: {}): Promise<void> {}`), top);
  }
});

test('the module is evaluated per call, so even the const escape hatch does not persist', async () => {
  const src = 'const state = { n: 0 };\nexport async function bump(args: {}): Promise<number> { return ++state.n; }';
  const parsed = parsePackage('Counter', src);
  const pkg = await buildPackageFn(stripper, src, parsed);
  for (let i = 0; i < 2; i++) {
    const events: ToolEvent[] = [];
    for await (const ev of runFunction(fakeMachine(), ctx, exportFn(pkg, 'bump'), [{}])) events.push(ev);
    assert.deepEqual(events.at(-1), { type: 'result', value: 1 });
  }
});

function memoryStore<T extends { id: string; version: string }>(docs: Map<string, T>): Store<T> {
  return {
    async get(id) { return docs.get(id) ?? null; },
    async set(id, v) { docs.set(id, v); },
    async cas(id, expected, next) {
      const cur = docs.get(id);
      if ((cur?.version ?? '') !== expected) return { ok: false, current: cur ?? null } as never;
      docs.set(id, next);
      return { ok: true } as never;
    },
    async delete(id) { return docs.delete(id); },
    async query() { const items = [...docs.values()].sort((a, b) => a.id.localeCompare(b.id)); return { items, total: items.length } as never; },
  };
}

async function boot(tools: Tool[], data: Map<string, Map<string, never>>): Promise<{ machine: MatbotMachine; teardown: () => Promise<void> }> {
  const machine = Object.assign(fakeMachine(tools), {
    TypeScriptStripper: stripper,
    Notifier: { notify() {} },
    mounted: { observe() {} },
    systemContext: { register() {} },
    createStore: (ns: string) => {
      if (!data.has(ns)) data.set(ns, new Map());
      return memoryStore(data.get(ns)!);
    },
  }) as unknown as MatbotMachine;
  const plugin = createFunctionToolsPlugin();
  await plugin.setup?.(machine);
  return { machine, teardown: async () => { await plugin.teardown?.(); } };
}

const resultOf = (events: ToolEvent[]): unknown => {
  const last = events.at(-1);
  if (last?.type === 'error') assert.fail(last.message);
  return last?.type === 'result' ? last.value : undefined;
};

test('define, call, redefine, collide, remove and reload a package through tool_function', async () => {
  const data = new Map<string, Map<string, never>>();
  const { machine, teardown } = await boot([sensor({ home: false })], data);

  const defined = resultOf(await run(machine, 'tool_function', { action: 'package', name: 'Presence', definition: PRESENCE })) as { tools: string[] };
  assert.deepEqual(defined.tools, ['Presence__where', 'Presence__room']);
  assert.equal(machine.tools.resolve('report'), null, 'a private helper is never a tool');
  assert.equal(resultOf(await run(machine, 'Presence__where', {})), 'out');
  assert.equal(resultOf(await run(machine, 'Presence__room', { fallback: 'nowhere' })), 'nowhere');
  assert.match(machine.tools.resolve('Presence__where')!.description, /^Whether Mat is at home/);

  // One export cannot be removed from under its siblings.
  const byTool = resultOf(await run(machine, 'tool_function', { action: 'remove', name: 'Presence__where' })) as { message: string };
  assert.match(byTool.message, /exported by package "Presence"/);
  assert.ok(machine.tools.resolve('Presence__where'));

  // Redefining replaces the group: an export that is gone stops being a tool.
  resultOf(await run(machine, 'tool_function', { action: 'package', name: 'Presence', definition: 'export async function where(args: {}): Promise<string> { return "here"; }' }));
  assert.equal(resultOf(await run(machine, 'Presence__where', {})), 'here');
  assert.equal(machine.tools.resolve('Presence__room'), null);

  // A clash on ANY export fails the whole definition, and leaves the previous group standing.
  machine.tools.register({ ...sensor(null), name: 'Presence__other' });
  const clash = await run(machine, 'tool_function', { action: 'package', name: 'Presence', definition: 'export async function fresh(args: {}): Promise<number> { return 1; }\nexport async function other(args: {}): Promise<number> { return 2; }' });
  assert.equal(clash.at(-1)?.type, 'error');
  assert.equal(machine.tools.resolve('Presence__fresh'), null, 'nothing is half-registered');
  assert.equal(resultOf(await run(machine, 'Presence__where', {})), 'here');

  const listed = resultOf(await run(machine, 'tool_function', { action: 'list' })) as { packages: { name: string; tools: string[]; definedUnchecked?: true }[] };
  assert.deepEqual(listed.packages.map(p => [p.name, p.tools, p.definedUnchecked]), [['Presence', ['Presence__where'], true]]);

  // Persisted: a fresh plugin over the same data registers the group again.
  await teardown();
  assert.equal(machine.tools.resolve('Presence__where'), null);
  const again = await boot([sensor({ home: true })], data);
  assert.equal(resultOf(await run(again.machine, 'Presence__where', {})), 'here');

  resultOf(await run(again.machine, 'tool_function', { action: 'remove', package: 'Presence' }));
  assert.equal(again.machine.tools.resolve('Presence__where'), null);
  assert.equal(data.get('function-packages')?.size, 0);
});

test('a package is type-checked as a whole, so a private helper is checked against its callers', async () => {
  let index: ToolTypeIndex | undefined;
  const machine = {
    configPath: join(import.meta.dirname, '..', '..', '..', 'matbot.yaml'),
    Notifier: { consume: () => {}, notify: () => {}, subscribe: () => (async function* () {})() },
    tools: { list: () => [], resolve: () => null, register() {}, remove() {}, removeByPlugin() {} },
    register: async (k: string, v: unknown) => { if (k === 'ToolTypeIndex') index = v as ToolTypeIndex; },
  } as unknown as MatbotMachine;
  await createToolTypesPlugin().setup?.(machine);
  assert.ok(index);

  const good = 'function double(n: number): number { return n * 2; }\nexport async function f(args: { n: number }): Promise<number> { return double(args.n); }';
  const bad  = 'function double(n: number): number { return n * 2; }\nexport async function f(args: { n: string }): Promise<number> { return double(args.n); }';
  const ok = await index.check(good);
  assert.equal(ok.ok, true, ok.diagnostics.map(d => d.rendered).join('\n'));
  const ko = await index.check(bad);
  assert.equal(ko.ok, false);
  assert.match(ko.diagnostics.map(d => d.rendered).join('\n'), /TS2345/);
});
