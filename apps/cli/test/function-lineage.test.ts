import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import type { MatbotMachine, PermissionDecision, PermissionRequest, PluginSettings, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { permitted, refused } from '@matatbread/matbot-core';
import { buildAsyncFn, runFunction, type CompileHost } from '@matatbread/matbot-function-tools';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';
import { Lineage } from '../../../plugins/function-tools/src/lineage.ts';
import { versionedSubject } from '../../../plugins/function-tools/src/compile.ts';

// A grant names the version of a function that was compiled, so an edit nobody approved does not inherit
// what the reviewed version was allowed. While a function is being worked on, that asked for its imports
// and connections again at every edit. An edit can now be permitted to keep them — per function, per
// session — while the grants themselves stay general, so the finished function still has them when it
// runs outside any session (a background job).

function memSettings(): PluginSettings {
  const m = new Map<string, unknown>();
  return { get: async <T>(k: string) => m.get(k) as T | undefined, set: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, entries: async () => Object.fromEntries(m) };
}

function ctxIn(session: string, decide: (r: PermissionRequest) => PermissionDecision, asked: PermissionRequest[] = []): ToolContext {
  return {
    callId: 'c', session: { id: session, messages: [] }, signal: new AbortController().signal,
    gate: async (r: PermissionRequest) => { asked.push(r); return decide(r); },
  } as unknown as ToolContext;
}

const V1 = `probe() { return import('node:os').then(() => 1); }`;
const V2 = `probe() { return import('node:os').then(() => 2); }`;
const V3 = `probe() { return import('node:os').then(() => 3); }`;

test('a permitted edit keeps the lineage, so the grants filed under it still apply', async () => {
  const lineage = new Lineage(memSettings());
  const asked: PermissionRequest[] = [];
  const v1 = await versionedSubject('probe', V1);

  assert.equal(await lineage.carry(ctxIn('S1', () => permitted('user'), asked), { kind: 'function', name: 'probe' },
    [{ tool: 'probe', before: V1, after: V2 }]), 'kept');
  assert.deepEqual(asked.map(r => [(r as { namespace?: string }).namespace, r.gate, r.subject, r.fallback]),
    [['tool_function', 'edit', 'probe@session:S1', false]]);
  assert.deepEqual(asked[0]?.standing?.map(s => s.subject), ['probe@session:S1']);
  assert.equal(await lineage.resolve(await versionedSubject('probe', V2)), v1);

  // A chain resolves to its first version; coming back to a version already permitted asks nothing.
  await lineage.carry(ctxIn('S1', () => permitted('user')), { kind: 'function', name: 'probe' }, [{ tool: 'probe', before: V2, after: V3 }]);
  assert.equal(await lineage.resolve(await versionedSubject('probe', V3)), v1);
  const again: PermissionRequest[] = [];
  assert.equal(await lineage.carry(ctxIn('S2', () => refused('user'), again), { kind: 'function', name: 'probe' },
    [{ tool: 'probe', before: V3, after: V2 }]), undefined);
  assert.equal(again.length, 0);
});

test('an edit not permitted, or made where nobody can be asked, starts a lineage of its own', async () => {
  const lineage = new Lineage(memSettings());
  assert.equal(await lineage.carry(ctxIn('S1', () => refused('user')), { kind: 'function', name: 'probe' },
    [{ tool: 'probe', before: V1, after: V2 }]), 'reset');
  const v2 = await versionedSubject('probe', V2);
  assert.equal(await lineage.resolve(v2), v2);
  // An HTTP call or a background job: nobody to ask, so the gate's fallback refuses.
  assert.equal(await lineage.carry(ctxIn('job', () => refused('fallback')), { kind: 'function', name: 'probe' },
    [{ tool: 'probe', before: V1, after: V3 }]), 'reset');
});

test('nothing is asked when there is nothing a grant could have been given for', async () => {
  const lineage = new Lineage(memSettings());
  const asked: PermissionRequest[] = [];
  const ctx = ctxIn('S1', () => permitted('user'), asked);
  assert.equal(await lineage.carry(ctx, { kind: 'function', name: 'f' }, [{ tool: 'f', before: 'f() { return 1; }', after: 'f() { return 2; }' }]), undefined);
  assert.equal(await lineage.carry(ctx, { kind: 'function', name: 'f' }, [{ tool: 'f', before: undefined, after: V1 }]), undefined, 'a new function');
  assert.equal(await lineage.carry(ctx, { kind: 'function', name: 'f' }, [{ tool: 'f', before: V1, after: V1 }]), undefined, 'no change');
  assert.equal(asked.length, 0);
});

test("a package is asked about once for all its exports", async () => {
  const lineage = new Lineage(memSettings());
  const asked: PermissionRequest[] = [];
  const P1 = `export async function a(x: {}): Promise<void> { await fetch('http://x'); }\nexport async function b(x: {}): Promise<void> {}`;
  const P2 = P1 + '\n// edited';
  assert.equal(await lineage.carry(ctxIn('S1', () => permitted('user'), asked), { kind: 'package', name: 'Pkg' },
    [{ tool: 'Pkg__a', before: P1, after: P2 }, { tool: 'Pkg__b', before: P1, after: P2 }]), 'kept');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.subject, 'Pkg@session:S1');
  for (const tool of ['Pkg__a', 'Pkg__b']) {
    assert.equal(await lineage.resolve(await versionedSubject(tool, P2)), await versionedSubject(tool, P1));
  }
});

test('at run time the grant is asked under the lineage, so a standing answer survives a permitted edit', async () => {
  const lineage = new Lineage(memSettings());
  const runner = createVmFunctionRunner(2000);
  const host: CompileHost = { TypeScriptStripper: { strip: (s: string) => stripTypeScriptTypes(s) }, FunctionRunner: runner };
  const machine = { tools: { list: () => [] as Tool[], resolve: () => null, register: () => {}, remove: () => false }, FunctionRunner: runner } as unknown as MatbotMachine;
  const importSubject = async (def: string, session: string): Promise<string> => {
    const asked: PermissionRequest[] = [];
    const fn = await buildAsyncFn(host, def, []);
    for await (const _ of runFunction(machine, ctxIn(session, () => permitted('user'), asked), fn, [], { tool: 'probe', source: def, resolve: lineage.resolve }) as AsyncIterable<ToolEvent>) { /* drain */ }
    return asked[0]!.subject;
  };
  const before = await importSubject(V1, 'S1');
  await lineage.carry(ctxIn('S1', () => permitted('user')), { kind: 'function', name: 'probe' }, [{ tool: 'probe', before: V1, after: V2 }]);
  assert.equal(await importSubject(V2, 'S1'), before, 'the same subject, so the same standing answer');
  assert.equal(await importSubject(V2, 'a-background-job'), before, 'wherever it runs: the grant is not per session');
});
