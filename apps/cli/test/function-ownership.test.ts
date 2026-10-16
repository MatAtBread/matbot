import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { HookRegistry, readOnlyError } from '@matatbread/matbot-core';
import type { MatbotMachine, Tool, ToolContext, ToolEvent, ToolTypeIndex } from '@matatbread/matbot-core';
import { createFunctionToolsPlugin } from '@matatbread/matbot-function-tools';

// What function-tools may do to the tool registry: only ever replace or remove a tool it put there, and
// only once the store has accepted the definition (#106, #107). A tool it did not register always wins
// over a stored definition, whether the clash is met at define, at reload, or after another plugin took
// the name over.

const SELF = '@matatbread/matbot-function-tools';

interface Rig {
  machine: MatbotMachine;
  docs:    (ns: string) => Map<string, { id: string; version: string; definition: string; checkedAgainst?: string }>;
  refuse:  Map<string, () => Error>;   // `set`/`cas` of this id throws
  foreign: (name: string, plugin?: string) => Tool;
  swap:    () => Promise<void>;        // what a StorageBackend swap does: re-run the reload
  call:    (input: unknown) => Promise<ToolEvent[]>;
}

async function rig(seed: (r: Omit<Rig, 'call' | 'swap'>) => void = () => {}): Promise<Rig> {
  const reg = new Map<string, Tool>();
  const data = new Map<string, Map<string, never>>();
  const refuse = new Map<string, () => Error>();
  const observers: (() => void | Promise<void>)[] = [];
  const docs = (ns: string) => {
    if (!data.has(ns)) data.set(ns, new Map());
    return data.get(ns)! as unknown as ReturnType<Rig['docs']>;
  };
  const index = {
    check: async () => ({ ok: true, checked: true, total: 0, diagnostics: [], environment: 'here' }),
    dts: async () => '',
  } as unknown as ToolTypeIndex;
  const machine = {
    self: { name: SELF, specifier: SELF },
    tools: {
      list: () => [...reg.values()],
      resolve: (n: string) => reg.get(n) ?? null,
      // As the host's plugin-scoped registry: every tool a plugin registers is stamped with its own name.
      register: (t: Tool) => { reg.set(t.name, { ...t, pluginName: SELF }); },
      remove: (n: string) => { reg.delete(n); },
      removeByPlugin: () => {},
    },
    hooks: new HookRegistry(),
    TypeScriptStripper: { strip: (s: string) => stripTypeScriptTypes(s) },
    ToolTypeIndex: index,
    Notifier: { notify() {}, consume() {} },
    mounted: { observe(_o: unknown, h: () => void | Promise<void>) { observers.push(h); } },
    systemContext: { register() {} },
    createStore: (ns: string) => {
      const m = docs(ns) as unknown as Map<string, { version: string }>;
      const guard = (id: string) => { const e = refuse.get(id); if (e !== undefined) throw e(); };
      return {
        get: async (id: string) => m.get(id) ?? null,
        set: async (id: string, v: never) => { guard(id); m.set(id, v); },
        delete: async (id: string) => m.delete(id),
        query: async () => ({ items: [...m.values()], total: m.size }),
        cas: async (id: string, expected: string, next: never) => {
          guard(id);
          const cur = m.get(id);
          if (cur?.version !== expected) return { ok: false, current: cur ?? null };
          const doc = { ...(next as object), version: `${expected}+` } as never;
          m.set(id, doc);
          return { ok: true, doc };
        },
      };
    },
  } as unknown as MatbotMachine;
  const foreign = (name: string, plugin = 'other-plugin'): Tool => {
    const t = { name, description: 'theirs', inputSchema: { type: 'object' }, pluginName: plugin,
                executor: { async *execute() { yield { type: 'result', value: 'theirs' } as ToolEvent; } } } as Tool;
    reg.set(name, t);
    return t;
  };
  seed({ machine, docs, refuse, foreign });
  await createFunctionToolsPlugin().setup?.(machine);
  const fn = machine.tools.resolve('tool_function')!;
  const call = async (input: unknown): Promise<ToolEvent[]> => {
    const ctx = { callId: 'c', session: { id: 's1', messages: [] }, signal: new AbortController().signal,
                  prompt: async () => { throw new Error('no prompt here'); } } as unknown as ToolContext;
    const out: ToolEvent[] = [];
    for await (const ev of fn.executor.execute(input, ctx)) out.push(ev);
    return out;
  };
  const swap = async () => { for (const h of observers) await h(); await new Promise(r => setTimeout(r, 0)); };
  return { machine, docs, refuse, foreign, swap, call };
}

const last = (evs: ToolEvent[]) => evs.at(-1) as { type: string; message?: string; value?: never };
const fnDoc = (definition: string, id: string) => ({ id, version: 'v1', definition });

test('a refused define leaves the previous tool registered and the store unchanged (#106)', async () => {
  const r = await rig();
  assert.equal(last(await r.call({ action: 'define', definition: 'sales_report(): string { return "alice"; }' })).type, 'result');
  const before = r.machine.tools.resolve('sales_report');

  r.refuse.set('sales_report', () => readOnlyError('functions', 'sales_report', 'alice'));
  const refused = last(await r.call({ action: 'define', definition: 'sales_report(): string { return "bob"; }' }));
  assert.equal(refused.type, 'error');
  assert.match(refused.message!, /was shared by "alice" and is read-only/, 'the store\'s reason is kept');
  assert.match(refused.message!, /choose another name for yours/);

  assert.equal(r.machine.tools.resolve('sales_report'), before, 'the registry still holds the persisted definition');
  assert.match(r.docs('functions').get('sales_report')!.definition, /"alice"/);
});

test('a refused define of a NEW name registers nothing, and the name can be defined again (#106)', async () => {
  const r = await rig();
  r.refuse.set('fresh', () => new Error('disk full'));
  const refused = last(await r.call({ action: 'define', definition: 'fresh(): number { return 1; }' }));
  assert.equal(refused.type, 'error');
  assert.equal(refused.message, 'disk full', 'a refusal that is not read-only is passed through as it came');
  assert.equal(r.machine.tools.resolve('fresh'), null);

  // It used to stay registered but untracked, so this was refused as "wasn't defined here".
  r.refuse.delete('fresh');
  assert.equal(last(await r.call({ action: 'define', definition: 'fresh(): number { return 1; }' })).type, 'result');
});

test('a refused package define leaves the previous group registered (#106)', async () => {
  const r = await rig();
  assert.equal(last(await r.call({ action: 'package', name: 'P', definition: 'export function a(x: {}): number { return 1; }' })).type, 'result');
  const before = r.machine.tools.resolve('P__a');

  r.refuse.set('P', () => readOnlyError('function-packages', 'P', 'alice'));
  const refused = last(await r.call({ action: 'package', name: 'P', definition: 'export function b(x: {}): number { return 2; }' }));
  assert.equal(refused.type, 'error');
  assert.match(refused.message!, /choose another name for yours/);
  assert.equal(r.machine.tools.resolve('P__a'), before);
  assert.equal(r.machine.tools.resolve('P__b'), null);
});

test('reload does not replace a tool another plugin registered, and says why the function is missing (#107)', async () => {
  const r = await rig(({ docs, foreign }) => {
    foreign('clickhouse_query');
    docs('functions').set('clickhouse_query', fnDoc('clickhouse_query(): string { return "alice"; }', 'clickhouse_query'));
    docs('functions').set('y', fnDoc('y(): number { return 1; }', 'y'));
  });
  assert.equal(r.machine.tools.resolve('clickhouse_query')?.pluginName, 'other-plugin');
  assert.equal(r.machine.tools.resolve('y')?.pluginName, SELF, 'control: a name nobody holds still registers');

  const list = last(await r.call({ action: 'list' })).value as unknown as { functions: { name: string; shadowedBy?: string }[] };
  assert.deepEqual(list.functions.map(f => [f.name, f.shadowedBy]), [['clickhouse_query', 'other-plugin'], ['y', undefined]]);

  const check = last(await r.call({ action: 'check', name: 'clickhouse_query' })).value as unknown as { results: { ok: boolean; diagnostics: { label: string }[] }[] };
  assert.equal(check.results[0]?.ok, false);
  assert.equal(check.results[0]?.diagnostics[0]?.label, 'SHADOWED');

  // `remove` drops the stored definition and leaves the other plugin's tool alone.
  await r.call({ action: 'remove', name: 'clickhouse_query' });
  assert.equal(r.machine.tools.resolve('clickhouse_query')?.pluginName, 'other-plugin');
});

test('a name another plugin took over is not taken back by a swap reload, nor by define (#107)', async () => {
  const r = await rig(({ docs }) => {
    docs('functions').set('x', fnDoc('x(): number { return 1; }', 'x'));
    docs('function-packages').set('P', fnDoc('export function a(v: {}): number { return 1; }', 'P'));
  });
  assert.equal(r.machine.tools.resolve('x')?.pluginName, SELF);
  // A later plugin registers `x`, and the host's overwrite gate lets it — at boot, without asking.
  r.foreign('x');
  r.foreign('P__a');

  await r.swap();
  assert.equal(r.machine.tools.resolve('x')?.pluginName, 'other-plugin', 'the swap re-run left it alone');
  assert.equal(r.machine.tools.resolve('P__a')?.pluginName, 'other-plugin');

  const redefined = last(await r.call({ action: 'define', definition: 'x(): number { return 2; }' }));
  assert.equal(redefined.type, 'error');
  assert.match(redefined.message!, /already exists and wasn't defined here/);
  assert.equal(r.machine.tools.resolve('x')?.pluginName, 'other-plugin');

  const list = last(await r.call({ action: 'list' })).value as unknown as { packages: { name: string; shadowed?: unknown }[] };
  assert.deepEqual(list.packages[0]?.shadowed, [{ tool: 'P__a', by: 'other-plugin' }]);
});

test('a check sweep survives a re-stamp the store refuses', async () => {
  const r = await rig(({ docs, refuse }) => {
    docs('functions').set('a', { ...fnDoc('a(): number { return 1; }', 'a'), checkedAgainst: 'elsewhere' });
    docs('functions').set('b', { ...fnDoc('b(): number { return 2; }', 'b'), checkedAgainst: 'elsewhere' });
    refuse.set('a', () => readOnlyError('functions', 'a', 'alice'));
  });
  const out = last(await r.call({ action: 'check' }));
  assert.equal(out.type, 'result', JSON.stringify(out));
  const { results } = out.value as unknown as { results: { name: string; ok: boolean }[] };
  assert.deepEqual(results.map(x => [x.name, x.ok]), [['a', true], ['b', true]]);
  assert.equal(r.docs('functions').get('b')!.checkedAgainst, 'here', 'the one that could be re-stamped was');
  assert.equal(r.docs('functions').get('a')!.checkedAgainst, 'elsewhere');
});
