import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeQuery } from '@matatbread/matbot-core/storage-base';
import type { MatbotMachine, Store, Tool, ToolEvent } from '@matatbread/matbot-core';
import { defineStore, plugin } from '../../../plugins/tool-store/src/index.ts';

// A plugin exposing its own store (`defineStore`, cognition's `remembered_facts`) registers its tool from
// its own setup. tool-store's boot used to register it first, from the persisted def — so the tool was
// tool-store's, the owner's re-registration was a collision ("cannot remove …", "Overwrite it?"), and the
// store stayed exposed with its owner unloaded.

type Doc = { id: string; version: string; [k: string]: unknown };

function memoryStore(): Store<Doc> {
  const map = new Map<string, Doc>();
  return {
    async get(id)             { return map.get(id) ?? null; },
    async set(id, v)          { map.set(id, v); },
    async cas(_id, _e, next)  { map.set(next.id, next); return { ok: true as const, doc: next }; },
    async delete(id)          { return map.delete(id); },
    async query(q)            { return executeQuery([...map.values()], q); },
  } as Store<Doc>;
}

// One process: stores shared by namespace, one tool registry. Each plugin's machine stamps its tools with
// its name and, as the host does, may remove only its own.
function host() {
  const stores = new Map<string, Store<Doc>>();
  const tools  = new Map<string, Tool>();
  const collisions: string[] = [];
  const refusals:   string[] = [];
  const machineOf = (name: string): MatbotMachine => ({
    self: { name },
    createStore: (ns: string) => { let s = stores.get(ns); if (!s) { s = memoryStore(); stores.set(ns, s); } return s; },
    tools: {
      register: (t: Tool) => { if (tools.has(t.name)) collisions.push(t.name); tools.set(t.name, { ...t, pluginName: name }); },
      remove:   (n: string) => {
        const held = tools.get(n);
        if (held === undefined) return;
        if (held.pluginName === name) tools.delete(n); else refusals.push(n);
      },
      resolve:  (n: string) => tools.get(n) ?? null,
      list:     () => [...tools.keys()],
    },
  }) as unknown as MatbotMachine;
  return { tools, collisions, refusals, machineOf };
}

const spec = { namespace: 'remembered_facts', description: 'facts', shape: 'interface Fact { fact: string }' };

async function call(tool: Tool, input: unknown): Promise<{ result?: unknown; error?: string }> {
  for await (const ev of tool.executor.execute(input, {} as never) as AsyncIterable<ToolEvent>) {
    if (ev.type === 'error')  return { error: ev.message };
    if (ev.type === 'result') return { result: ev.value };
  }
  return {};
}

test('a plugin\'s own store is recorded as its, and tool-store\'s boot leaves it to the owner', async () => {
  const h = host();
  // First run: tool-store, then the owner exposes its store.
  await plugin.setup!(h.machineOf('@x/tool-store'));
  await defineStore(h.machineOf('@x/cognition'), spec);
  assert.equal(h.tools.get('remembered_facts_action')?.pluginName, '@x/cognition');

  // Restart, over the same stores: no collision, no refused remove, and the owner holds its tool.
  const again = host();
  const shared = h.machineOf('@x/tool-store').createStore;
  const boot = (name: string): MatbotMachine => ({ ...again.machineOf(name), createStore: shared }) as MatbotMachine;
  await plugin.setup!(boot('@x/tool-store'));
  assert.equal(again.tools.has('remembered_facts_action'), false, 'not registered by tool-store');
  await defineStore(boot('@x/cognition'), spec);
  assert.deepEqual([again.collisions, again.refusals], [[], []]);
  assert.equal(again.tools.get('remembered_facts_action')?.pluginName, '@x/cognition');

  // A restart without the owner exposes nothing.
  const without = host();
  await plugin.setup!({ ...without.machineOf('@x/tool-store'), createStore: shared } as MatbotMachine);
  assert.equal(without.tools.has('remembered_facts_action'), false);
});

test('a def from before owners keeps registering at boot, and the owner\'s next define records it', async () => {
  const h = host();
  const meta = h.machineOf('@x/tool-store').createStore('store_tools');
  await meta.set('remembered_facts', { id: 'remembered_facts', version: 'v0', namespace: 'remembered_facts', description: 'facts',
    shape: spec.shape, createdAt: 't', updatedAt: 't' });
  await plugin.setup!(h.machineOf('@x/tool-store'));
  assert.equal(h.tools.get('remembered_facts_action')?.pluginName, '@x/tool-store', 'unowned: as before');
  await defineStore(h.machineOf('@x/cognition'), spec);
  assert.equal((await meta.get('remembered_facts'))?.['owner'], '@x/cognition');
});

test('store_action cannot remove a store its owner is exposing, and can tidy one whose owner has gone', async () => {
  const h = host();
  await plugin.setup!(h.machineOf('@x/tool-store'));
  await defineStore(h.machineOf('@x/cognition'), spec);
  const storeAction = h.tools.get('store_action')!;
  const refused = await call(storeAction, { action: 'remove', name: 'remembered_facts' });
  assert.match(refused.error ?? '', /belongs to the plugin "@x\/cognition"/);
  assert.equal(h.tools.has('remembered_facts_action'), true);

  h.tools.delete('remembered_facts_action');   // the owner unloaded
  assert.deepEqual(await call(storeAction, { action: 'remove', name: 'remembered_facts' }), { result: { removed: true } });
});
