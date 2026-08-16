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
