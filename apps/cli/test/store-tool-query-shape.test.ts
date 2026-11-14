import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeQuery } from '@matatbread/matbot-core/storage-base';
import type { Store, Tool, ToolEvent } from '@matatbread/matbot-plugin-api';
import { defineStore } from '../../../plugins/tool-store/src/index.ts';

// A generated store tool takes the query grammar under a `query` parameter, and its `inputSchema` is
// loose by design (multi-action tools declare `required: ['action']` and let the executor enforce).
// So `{ action: 'query', limit: 0 }` — the grammar flattened one level up — used to reach
// `store.query(input.query ?? {})` as `{}`: the limit was discarded, the query degraded to
// match-everything, and the COUNT form came back as every document in the store plus a total. That
// reads like a working answer, which is what makes it worth an error rather than a shrug.
//
// This is the same failure `validateQuery` rejects unknown top-level keys to prevent ("a clause under
// a wrong key is dropped, the query degrades to match-everything, and the author gets a plausible
// result with no signal it was malformed") — it simply reappears at the tool boundary, which
// `validateQuery` never sees, because the misplaced key never becomes part of a StoreQuery at all.

type Doc = Record<string, unknown> & { id: string; version: string };

function memoryStore(seed: Doc[]): Store<Doc> {
  const map = new Map(seed.map(d => [d.id, d]));
  return {
    async get(id)             { return map.get(id) ?? null; },
    async set(id, v)          { map.set(id, v); },
    async cas(_id, _e, next)  { return { ok: true as const, doc: next }; },
    async delete(id)          { return map.delete(id); },
    async query(q)            { return executeQuery([...map.values()], q); },
  };
}

// A minimal stand-in for the slice of MatbotMachine `defineStore` touches. Stores are per-namespace:
// defineStore writes its own def to a meta namespace alongside the governed one.
function machine(seed: Record<string, Doc[]>): { tools: Tool[]; services: Parameters<typeof defineStore>[0] } {
  const tools:  Tool[] = [];
  const stores = new Map<string, Store<Doc>>();
  const services = {
    createStore: (ns: string) => {
      const hit = stores.get(ns) ?? memoryStore(seed[ns] ?? []);
      stores.set(ns, hit);
      return hit;
    },
    tools: {
      register: (t: Tool) => { tools.push(t); },
      remove:   (name: string) => {
        const i = tools.findIndex(t => t.name === name);
        if (i >= 0) tools.splice(i, 1);
      },
      resolve: (name: string) => tools.find(t => t.name === name) ?? null,
      list: () => tools.map(t => t.name),
    },
  } as unknown as Parameters<typeof defineStore>[0];
  return { tools, services };
}

async function call(tool: Tool, input: unknown): Promise<{ result?: unknown; error?: string }> {
  for await (const ev of tool.executor.execute(input, {} as never) as AsyncIterable<ToolEvent>) {
    if (ev.type === 'error')  return { error: ev.message };
    if (ev.type === 'result') return { result: ev.value };
  }
  return {};
}

const docs = [
  { id: 'f1', version: 'v1', fact: 'the first fact' },
  { id: 'f2', version: 'v1', fact: 'the second fact' },
];

async function storeTool(): Promise<Tool> {
  const { tools, services } = machine({ remembered_facts: docs });
  await defineStore(services, {
    namespace:   'remembered_facts',
    description: 'facts',
    shape:       'interface RememberedFact { fact: string }',
  });
  const tool = tools.find(t => t.name === 'remembered_facts_action');
  assert.ok(tool !== undefined, 'defineStore must register the generated action tool');
  return tool;
}

// The exact sequence from session a71b210d: the model issued BOTH shapes, so the nested one has to
// keep working while the flattened one starts failing loudly.
test('the count form works when the grammar is nested under `query`', async () => {
  const { result } = await call(await storeTool(), { action: 'query', query: { limit: 0 } });
  assert.deepEqual(result, { items: [], total: 2 });
});

test('a grammar key beside `action` is rejected, not silently matched-everything', async () => {
  const { result, error } = await call(await storeTool(), { action: 'query', limit: 0 });
  assert.equal(result, undefined, 'the count form must not come back as every document in the store');
  assert.match(String(error), /"limit"/);
  assert.match(String(error), /inside "query"/);
});

test('every grammar key is caught, and they are named together', async () => {
  for (const key of ['where', 'sort', 'cursor', 'immutable']) {
    const { error } = await call(await storeTool(), { action: 'query', [key]: 1 });
    assert.match(String(error), new RegExp(`"${key}"`), `${key} beside action must be rejected`);
  }
  const { error } = await call(await storeTool(), { action: 'query', limit: 0, sort: [] });
  assert.match(String(error), /"sort".*"limit"|"limit".*"sort"/s, 'both misplaced keys should be named at once');
});

test('a query with no grammar keys at all still matches everything', async () => {
  const { result } = await call(await storeTool(), { action: 'query' });
  assert.deepEqual((result as { items: unknown[] }).items.length, 2, 'an omitted query still means match-all');
});

// ── store_action create: the name is LLM-supplied, and it is not an opaque key ────────────────────
//
// It becomes part of a namespace, which the filesystem backend makes a directory name verbatim
// (document ids are percent-encoded, namespaces never were), so it is checked where untrusted names
// arrive rather than defended against in every backend.

async function storeActionTool(existing: Record<string, Doc[]> = {}, preset: Tool[] = []): Promise<{ tool: Tool; tools: Tool[] }> {
  const { tools, services } = machine(existing);
  tools.push(...preset);
  // Give the machine a backend that can enumerate, so the create guard has something to ask.
  (services as unknown as { StorageBackend: unknown }).StorageBackend = {
    createStore: (ns: string) => (services as unknown as { createStore(n: string): unknown }).createStore(ns),
    fileStore:   {},
    namespaces:  async () => Object.keys(existing).filter(ns => (existing[ns] ?? []).length > 0).sort(),
  };
  const { plugin } = await import('../../../plugins/tool-store/src/index.ts');
  await plugin.setup!(services as never);
  const tool = tools.find(t => t.name === 'store_action');
  assert.ok(tool !== undefined, 'the plugin must register store_action');
  return { tool, tools };
}

const created = { description: 'notes', shape: 'interface N { text: string }' };

test('a name that would escape the data directory is rejected', async () => {
  const { tool } = await storeActionTool();
  for (const name of ['../evil', 'a/b', '.', '..', 'a\\b']) {
    const { error, result } = await call(tool, { action: 'create', name, ...created });
    assert.equal(result, undefined, `${name} must not create a store`);
    assert.match(String(error), /not a valid store name/, `${name} must be rejected`);
  }
});

test("a created store lives in tool-store's own namespace, never a plugin's", async () => {
  const { tool, tools } = await storeActionTool({ sessions: [{ id: 's1', version: 'v1' }] });
  const { error, result } = await call(tool, { action: 'create', name: 'sessions', ...created });
  assert.equal(error, undefined);
  assert.equal((result as { namespace: string }).namespace, 'store-sessions');
  const generated = tools.find(t => t.name === 'sessions_action');
  assert.ok(generated !== undefined);
  const { result: page } = await call(generated, { action: 'query' });
  assert.equal((page as { items: unknown[] }).items.length, 0, "the plugin's sessions are not reachable");
});

test('expose is gone: a model cannot open a store it did not create', async () => {
  const { tool } = await storeActionTool({ settings: [{ id: 'x', version: 'v1' }] });
  const { error, result } = await call(tool, { action: 'expose', name: 'settings', ...created });
  assert.equal(result, undefined);
  assert.match(String(error), /Unknown action "expose"/);
});

test('a name whose generated tool another plugin provides is refused', async () => {
  const gate = { name: 'gate_action', description: '', inputSchema: {}, executor: { async *execute() {} } } as unknown as Tool;
  const { tool, tools } = await storeActionTool({}, [gate]);
  const { error, result } = await call(tool, { action: 'create', name: 'gate', ...created });
  assert.equal(result, undefined);
  assert.match(String(error), /would generate the tool "gate_action", which the host already provides/);
  assert.equal(tools.find(t => t.name === 'gate_action'), gate, 'the existing tool is untouched');
});

test('remove of a name with no definition removes no tool', async () => {
  const gate = { name: 'gate_action', description: '', inputSchema: {}, executor: { async *execute() {} } } as unknown as Tool;
  const { tool, tools } = await storeActionTool({}, [gate]);
  const { result } = await call(tool, { action: 'remove', name: 'gate' });
  assert.deepEqual(result, { removed: false });
  assert.ok(tools.includes(gate));
});

test("re-creating a removed store's name re-attaches its documents", async () => {
  const { tool, tools } = await storeActionTool({ 'store-notes': [{ id: 'n1', version: 'v1', text: 'kept' }] });
  const { error } = await call(tool, { action: 'create', name: 'notes', ...created });
  assert.equal(error, undefined);
  const { result: page } = await call(tools.find(t => t.name === 'notes_action')!, { action: 'query' });
  assert.equal((page as { items: unknown[] }).items.length, 1);
});

test('a name differing only by case is refused', async () => {
  const { tool } = await storeActionTool({ 'store-notes': [{ id: 'n1', version: 'v1' }] });
  const { error, result } = await call(tool, { action: 'create', name: 'Notes', ...created });
  assert.equal(result, undefined, 'one directory on macOS and Windows');
  assert.match(String(error), /collides with the existing namespace "store-notes"/);
});

test('a persisted def over a namespace the host refuses is skipped, not fatal', async () => {
  const legacy = { id: 'settings', version: 'v1', namespace: 'settings', description: 'd', shape: 'interface S { data: object }', createdAt: '', updatedAt: '' };
  const { tools, services } = machine({ store_tools: [legacy] });
  const open = (services as unknown as { createStore(n: string): unknown }).createStore;
  (services as unknown as { createStore(n: string): unknown }).createStore = (ns: string) => {
    if (ns === 'settings') throw new Error('refused');
    return open(ns);
  };
  const { plugin } = await import('../../../plugins/tool-store/src/index.ts');
  await plugin.setup!(services as never);
  assert.ok(tools.some(t => t.name === 'store_action'));
  assert.ok(!tools.some(t => t.name === 'settings_action'));
});
