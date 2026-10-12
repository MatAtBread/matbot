import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { HookRegistry } from '@matatbread/matbot-core';
import type { MatbotMachine, Tool, ToolContext, ToolEvent, ToolTypeIndex } from '@matatbread/matbot-core';
import { createFunctionToolsPlugin } from '@matatbread/matbot-function-tools';
import { createToolTypesPlugin } from '@matatbread/matbot-tool-types';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

// A type-check verdict is a claim about an environment, and the environment is a plugin: unload the node
// FunctionRunner, or narrow what it permits a body to import, and a stored "this passed" is a claim about
// somewhere else. Nothing re-checks on load, so the environment the check ran in is stored beside the
// definition and compared — which is the only thing that can tell a reader the ground has moved.

function machineWith(extra: Record<string, unknown>): MatbotMachine {
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
        cas: async (id: string, expected: string, next: never) => {
          const cur = docs.get(id) as { version?: string } | undefined;
          if (cur?.version !== expected) return { ok: false, current: cur ?? null };
          const doc = { ...(next as object), version: `${expected}+` } as never;
          docs.set(id, doc);
          return { ok: true, doc };
        },
      };
    },
  }, extra) as unknown as MatbotMachine;
}

type Row = { name: string; definedUnchecked?: true; checkedElsewhere?: true };

test('a stored verdict carries the environment it was reached in, and says when that has moved', { timeout: 60000 }, async () => {
  let index: ToolTypeIndex | undefined;
  const machine = machineWith({
    configPath: join(import.meta.dirname, '..', '..', '..', 'matbot.yaml'),
    register: async (k: string, v: unknown) => { if (k === 'ToolTypeIndex') index = v as ToolTypeIndex; },
  });
  await createToolTypesPlugin().setup?.(machine);
  Object.assign(machine, { ToolTypeIndex: index, FunctionRunner: createVmFunctionRunner(0, { permit: ['node:os'] }) });
  await createFunctionToolsPlugin().setup?.(machine);
  const fn = machine.tools.resolve('tool_function')!;

  const session = { id: 's1', messages: [] };
  const call = async (input: unknown): Promise<ToolEvent[]> => {
    const ctx = { callId: 'c', session, signal: new AbortController().signal,
                  prompt: async () => { throw new Error('no prompt here'); } } as unknown as ToolContext;
    const out: ToolEvent[] = [];
    for await (const ev of fn.executor.execute(input, ctx)) out.push(ev);
    return out;
  };
  const row = async (): Promise<Row> => {
    const last = (await call({ action: 'list' })).at(-1) as { value: { functions: Row[] } };
    return last.value.functions[0]!;
  };
  const runner = (permit?: string[]): void => {
    Object.assign(machine, { FunctionRunner: permit === undefined ? undefined : createVmFunctionRunner(0, { permit }) });
  };

  const defined = await call({ action: 'define', definition: 'sum(a: number, b: number): number { return a + b; }' });
  assert.equal(defined.at(-1)?.type, 'result', JSON.stringify(defined.at(-1)));
  assert.deepEqual(await row(), { name: 'sum', definition: 'sum(a: number, b: number): number { return a + b; }' },
    'checked here and now: neither flag, and the fingerprint itself is never handed out');

  // Narrowing the permitted set is a different environment, and the verdict is unchanged: it DID pass —
  // where it passed is the thing being reported.
  runner([]);
  assert.equal((await row()).checkedElsewhere, true);
  assert.equal((await row()).definedUnchecked, undefined);

  // Unloading the runner plugin altogether: the body is no longer bounded and its import no longer gated.
  runner(undefined);
  assert.equal((await row()).checkedElsewhere, true);

  // The same permitted set again is the SAME environment, though it is a different runner object and a
  // different array — the fingerprint has to survive a restart, so it cannot be identity-derived.
  runner(['node:os']);
  assert.equal((await row()).checkedElsewhere, undefined);

  // A `check` row is the verdict reached HERE, so it says nothing about where an older one was reached,
  // and hands out no fingerprint. Beside a fresh pass, `checkedElsewhere` read as "passed now, and passed
  // somewhere else".
  runner(['node:fs']);
  assert.equal((await row()).checkedElsewhere, true);
  const rows = ((await call({ action: 'check' })).at(-1) as { value: { results: (Row & { ok: boolean; environment?: string })[] } }).value.results;
  assert.deepEqual(rows.map(r => [r.name, r.ok, r.checkedElsewhere, r.environment]), [['sum', true, undefined, undefined]]);
  // And the pass is recorded, so `list` stops flagging a function that was just re-verified — otherwise
  // the only way to clear the flag was to redefine a correct function.
  assert.equal((await row()).checkedElsewhere, undefined);
});

test('a session check stamp applies only to the definition it checked', async () => {
  // A session function lives in its markers, so a passing re-check is recorded as one too. It must not
  // vouch for a later redefinition — nor, on a fork that replaced the function, for source it never saw.
  const { sessionFunctions, MARKER_CREATOR } = await import('../../../plugins/function-tools/src/session.ts');
  const marker = (data: unknown) => ({ role: 'marker', content: [{ type: 'marker', creator: MARKER_CREATOR, data }] });
  const session = (...data: unknown[]) => ({ id: 's', messages: data.map(marker) }) as never;
  const v1 = 'f(): number { return 1; }', v2 = 'f(): number { return 2; }';

  const stamped = sessionFunctions(session(
    { op: 'define', name: 'f', definition: v1, checkedAgainst: 'old' },
    { op: 'checked', name: 'f', definition: v1, checkedAgainst: 'new' }));
  assert.equal(stamped.get('f')?.checkedAgainst, 'new');

  const stale = sessionFunctions(session(
    { op: 'define', name: 'f', definition: v1, checkedAgainst: 'old' },
    { op: 'define', name: 'f', definition: v2, checkedAgainst: 'v2' },
    { op: 'checked', name: 'f', definition: v1, checkedAgainst: 'new' }));
  assert.equal(stale.get('f')?.checkedAgainst, 'v2', 'a stamp for v1 does not apply to v2');

  const gone = sessionFunctions(session(
    { op: 'define', name: 'f', definition: v1 }, { op: 'remove', name: 'f' },
    { op: 'checked', name: 'f', definition: v1, checkedAgainst: 'new' }));
  assert.equal(gone.has('f'), false, 'a stamp does not bring a removed function back');
});
