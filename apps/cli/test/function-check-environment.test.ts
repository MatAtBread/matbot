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

  // A `check` re-run says the same, beside its own verdict.
  runner(['node:fs']);
  const rows = ((await call({ action: 'check' })).at(-1) as { value: { results: Row[] } }).value.results;
  assert.deepEqual(rows.map(r => [r.name, r.checkedElsewhere]), [['sum', true]]);
});
