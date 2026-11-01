import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { HookRegistry } from '@matatbread/matbot-core';
import type { MatbotMachine, PermissionRequest, Tool, ToolContext, ToolEvent, ToolTypeIndex } from '@matatbread/matbot-core';
import { createFunctionToolsPlugin } from '@matatbread/matbot-function-tools';
import { createToolTypesPlugin } from '@matatbread/matbot-tool-types';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

// A type-check verdict is a claim about an environment, and the environment is a plugin: unload the node
// FunctionRunner and a stored "this passed" is a claim about somewhere else. Nothing re-checks on load, so the environment the check ran in is stored beside the
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
    projectDir: join(import.meta.dirname, '..', '..', '..'),
    register: async (k: string, v: unknown) => { if (k === 'ToolTypeIndex') index = v as ToolTypeIndex; },
  });
  await createToolTypesPlugin().setup?.(machine);
  Object.assign(machine, { ToolTypeIndex: index, FunctionRunner: createVmFunctionRunner(0) });
  await createFunctionToolsPlugin().setup?.(machine);
  const fn = machine.tools.resolve('tool_function')!;

  const session = { id: 's1', messages: [] };
  const call = async (input: unknown): Promise<ToolEvent[]> => {
    const ctx = { callId: 'c', session, signal: new AbortController().signal,
                  prompt: async () => { throw new Error('no prompt here'); },
                  gateSnapshot: async () => () => ({ allowed: false, source: 'fallback' }) } as unknown as ToolContext;
    const out: ToolEvent[] = [];
    for await (const ev of fn.executor.execute(input, ctx)) out.push(ev);
    return out;
  };
  const row = async (): Promise<Row> => {
    const last = (await call({ action: 'list' })).at(-1) as { value: { functions: Row[] } };
    return last.value.functions[0]!;
  };
  const runner = (present: boolean): void => {
    Object.assign(machine, { FunctionRunner: present ? createVmFunctionRunner(0) : undefined });
  };

  const defined = await call({ action: 'define', definition: 'sum(a: number, b: number): number { return a + b; }' });
  assert.equal(defined.at(-1)?.type, 'result', JSON.stringify(defined.at(-1)));
  assert.deepEqual(await row(), { name: 'sum', definition: 'sum(a: number, b: number): number { return a + b; }' },
    'checked here and now: neither flag, and the fingerprint itself is never handed out');

  // Unloading the runner plugin: the body is no longer bounded and its import no longer gated. The
  // verdict is unchanged — it DID pass — and where it passed is the thing being reported.
  runner(false);
  assert.equal((await row()).checkedElsewhere, true);
  assert.equal((await row()).definedUnchecked, undefined);

  // A runner again is the SAME environment, though it is a different object — the fingerprint has to
  // survive a restart, so it cannot be identity-derived.
  runner(true);
  assert.equal((await row()).checkedElsewhere, undefined);

  // A `check` row is the verdict reached HERE, so it says nothing about where an older one was reached,
  // and hands out no fingerprint. Beside a fresh pass, `checkedElsewhere` read as "passed now, and passed
  // somewhere else".
  runner(false);
  assert.equal((await row()).checkedElsewhere, true);
  const rows = ((await call({ action: 'check' })).at(-1) as { value: { results: (Row & { ok: boolean; environment?: string })[] } }).value.results;
  assert.deepEqual(rows.map(r => [r.name, r.ok, r.checkedElsewhere, r.environment]), [['sum', true, undefined, undefined]]);
  // And the pass is recorded, so `list` stops flagging a function that was just re-verified — otherwise
  // the only way to clear the flag was to redefine a correct function.
  assert.equal((await row()).checkedElsewhere, undefined);
});

test('a definition is checked against what the gate refuses that function, and only where a runner routes it', { timeout: 60000 }, async () => {
  let index: ToolTypeIndex | undefined;
  const machine = machineWith({
    projectDir: join(import.meta.dirname, '..', '..', '..'),
    register: async (k: string, v: unknown) => { if (k === 'ToolTypeIndex') index = v as ToolTypeIndex; },
  });
  await createToolTypesPlugin().setup?.(machine);
  Object.assign(machine, { ToolTypeIndex: index, FunctionRunner: createVmFunctionRunner(0) });
  await createFunctionToolsPlugin().setup?.(machine);
  const fn = machine.tools.resolve('tool_function')!;

  // A policy with one standing denial: `node:os` for every function, matched the way the default gate
  // matches — against the subject and each standing subject the call site offers.
  const asked: PermissionRequest[] = [];
  const snapshot = (req: PermissionRequest & { namespace?: string }) => {
    asked.push(req);
    const candidates = [req.subject, ...(req.standing ?? []).map(o => o.subject)];
    return candidates.includes('* node:os') && req.namespace === 'tool_function' && req.gate === 'import'
      ? { allowed: false, source: 'configuration' } : { allowed: false, source: 'fallback' };
  };
  const call = async (input: unknown): Promise<ToolEvent[]> => {
    const ctx = { callId: 'c', session: { id: 's1', messages: [] }, signal: new AbortController().signal,
                  prompt: async () => { throw new Error('no prompt here'); },
                  gateSnapshot: async () => snapshot } as unknown as ToolContext;
    const out: ToolEvent[] = [];
    for await (const ev of fn.executor.execute(input, ctx)) out.push(ev);
    return out;
  };

  const refused = await call({ action: 'define', definition: 'host(): Promise<string> { const os = await import("node:os"); return os.hostname(); }' });
  assert.equal(refused.at(-1)?.type, 'error', JSON.stringify(refused.at(-1)));
  assert.match((refused.at(-1) as { message: string }).message, /IMPORT-GATE[\s\S]*'node:os' is refused/);
  // Asked as the call would ask: under the function's own subject, with the `*` answer among its standing.
  assert.ok(asked.some(r => /^host@[0-9a-f]+ node:os$/.test(r.subject)), asked.map(r => r.subject).join(', '));

  // The unprefixed spelling is the same module, and the same refusal.
  const bare = await call({ action: 'define', definition: 'host2(): Promise<string> { const os = await import("os"); return os.hostname(); }' });
  assert.equal(bare.at(-1)?.type, 'error');

  // A module nobody refused is typed and passes: "nobody decided" is asked at the call, not refused here.
  const fine = await call({ action: 'define', definition: 'cwd(): Promise<string> { const p = await import("node:path"); return p.sep; }' });
  assert.equal(fine.at(-1)?.type, 'result', JSON.stringify(fine.at(-1)));

  // With no runner nothing routes the import to the gate, so a refusal reported here would be untrue.
  Object.assign(machine, { FunctionRunner: undefined });
  asked.length = 0;
  const ungated = await call({ action: 'execute', definition: '{ const os = await import("node:os"); return typeof os.hostname; }' });
  assert.equal(asked.length, 0, 'the gate is not consulted');
  assert.doesNotMatch(JSON.stringify(ungated), /IMPORT-GATE/);
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
