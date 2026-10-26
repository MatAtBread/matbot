import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegistryChangeKind } from '@matatbread/matbot-core';
import type { MatbotMachine, Notification, QueryResult, Store, StoreQuery, Tool } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { plugin } from '../../../plugins/tool-router/src/index.ts';

// tool-router warms its noun/width cache by enqueuing every registered tool. It used to read the cache with
// one `get` per tool, in sequence — one network round trip each on a remote StorageBackend, holding a
// connection for the whole warm-up (#109). It now reads each queued batch with one `in` query, and falls
// back to per-key `get` only when that query fails; falling back to "uncached" instead would mean an LLM
// call per tool.

interface Rec { id: string; version: string }

function counting(inner: Store<Rec>, failQuery = false): Store<Rec> & { gets: number; queries: number; sets: number } {
  const s = {
    gets: 0, queries: 0, sets: 0,
    get:    (id: string) => { s.gets++; return inner.get(id); },
    query:  async (q: StoreQuery): Promise<QueryResult<Rec>> => {
      s.queries++;
      if (failQuery) throw new Error('query unavailable');
      return inner.query(q);
    },
    set:    (id: string, v: Rec) => { s.sets++; return inner.set(id, v); },
    cas:    (id: string, e: string, v: Rec) => inner.cas(id, e, v),
    delete: (id: string, v?: string) => inner.delete(id, v),
  };
  return s;
}

const tool = (name: string): Tool => ({
  name,
  description: `Does the ${name} thing`,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  executor: { async *execute() { return undefined; } },
} as unknown as Tool);

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

async function boot(store: Store<Rec>, names: string[]): Promise<{ derivations: () => number; add: (name: string) => Promise<void> }> {
  const tools = new Map(names.map(n => [n, tool(n)]));
  let derivations = 0;
  let onChange: ((n: Notification) => void) | undefined;
  const services = {
    isSubAgent:  () => false,
    createStore: (ns: string) => (ns === 'tool_router_nouns' ? store : new MemoryStore()),
    settings:    () => ({ get: async () => undefined, entries: async () => ({}), set: async () => {}, delete: async () => {} }),
    providers:   new Map([['p', {}]]),
    register:    async () => {},
    singleTurn:  async () => { derivations++; return { text: 'NOUNS: things\nWIDTH: specific' }; },
    Notifier:    { consume: (fn: (n: Notification) => void) => { onChange = fn; } },
    tools: {
      list:     () => [...tools.values()],
      resolve:  (n: string) => tools.get(n),
      register: (t: Tool) => { tools.set(t.name, t); },
    },
  } as unknown as MatbotMachine;

  const warn = console.warn;
  console.warn = () => {};
  try { await plugin.setup!(services); await settle(); } finally { console.warn = warn; }
  return {
    derivations: () => derivations,
    add: async name => {
      tools.set(name, tool(name));
      console.warn = () => {};
      try {
        onChange?.({ kind: RegistryChangeKind, registry: 'tools', name, operation: 'added' } as Notification);
        await settle();
      } finally { console.warn = warn; }
    },
  };
}

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
// The router registers `tool_router_config` itself, and derives it like any other tool (`tool_search` it skips).
const LIBRARY = NAMES.length + 1;

async function warmed(): Promise<MemoryStore<Rec>> {
  const inner = new MemoryStore<Rec>();
  await boot(inner, NAMES);
  return inner;
}

test('a warm cache is read with one query at boot, not one get per tool', async () => {
  const store = counting(await warmed());
  const { derivations } = await boot(store, NAMES);
  assert.equal(store.queries, 1);
  assert.equal(store.gets, 0);
  assert.equal(derivations(), 0, 'every tool was a hit');
  assert.equal(store.sets, 0);
});

test('a cold cache is one query, then a derivation per tool and no per-key reads', async () => {
  const store = counting(new MemoryStore<Rec>());
  const { derivations } = await boot(store, NAMES);
  assert.equal(store.queries, 1);
  assert.equal(store.gets, 0, 'a key missing from a successful query is a genuine miss, not read again');
  assert.equal(derivations(), LIBRARY);
  assert.equal(store.sets, LIBRARY);
});

test('a tool registered after boot is still read, and derived on a miss', async () => {
  const store = counting(await warmed());
  const { derivations, add } = await boot(store, NAMES);
  await add('zeta');
  assert.equal(store.queries, 2, 'the late tool is its own batch');
  assert.equal(derivations(), 1, 'only the new tool missed');
  assert.equal(store.sets, 1);
});

test('a query that throws falls back to per-key get, not to deriving every tool', async () => {
  const store = counting(await warmed(), true);
  const { derivations } = await boot(store, NAMES);
  assert.equal(store.gets, LIBRARY);
  assert.equal(derivations(), 0);
});
