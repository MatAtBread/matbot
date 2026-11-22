import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyError } from '@matatbread/matbot-core';
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

const legacyDef = (id: string) => ({
  id, version: 'v0', namespace: id, description: 'from 0.4', shape: 'interface Fact { fact: string }',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

test('a def from before 0.5.0 is handed to its owner when the owner defines it, unmoved', async () => {
  const h = host();
  await h.machineOf('@x/tool-store').createStore('store_tools').set('remembered_facts', legacyDef('remembered_facts'));
  await plugin.setup!(h.machineOf('@x/tool-store'));
  assert.equal(h.tools.get('remembered_facts_action')?.pluginName, '@x/tool-store', 'still registered, as before');

  await defineStore(h.machineOf('@x/cognition'), spec);
  assert.deepEqual([h.collisions, h.refusals], [[], []], 'handed over, not collided');
  assert.equal(h.tools.get('remembered_facts_action')?.pluginName, '@x/cognition');
  const def = await h.machineOf('@x/tool-store').createStore('store_tools').get('remembered_facts') as { owner?: string; namespace: string } | null;
  assert.deepEqual([def?.owner, def?.namespace], ['@x/cognition', 'remembered_facts'], 'recorded as the owner\'s, in its own namespace');
});

test('a def from before 0.5.0 with no owner moves into a namespace of tool-store\'s own on first use, keeping its documents', async () => {
  const h = host();
  const ts = h.machineOf('@x/tool-store');
  await ts.createStore('store_tools').set('notes', legacyDef('notes'));
  await ts.createStore('notes').set('n1', { id: 'n1', version: 'a', fact: 'kept' });
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: unknown) => { warned.push(String(m)); };
  try {
    await plugin.setup!(ts);
    assert.deepEqual(warned, [], 'nothing to say at boot');
    const got = await call(h.tools.get('notes_action')!, { action: 'get', id: 'n1' });
    assert.equal((got.result as { fact?: string } | null)?.fact, 'kept');
    await call(h.tools.get('notes_action')!, { action: 'set', id: 'n2', data: { fact: 'new' } });
  } finally { console.warn = warn; }
  assert.ok(warned.some(m => /"notes" was defined before 0\.5\.0.*"store-notes" \(1 copied\)/.test(m)));
  const def = await ts.createStore('store_tools').get('notes') as { namespace: string } | null;
  assert.equal(def?.namespace, 'store-notes');
  assert.ok(await ts.createStore('store-notes').get('n2'), 'later writes land in its own namespace');
  assert.equal(await ts.createStore('notes').get('n2'), null, 'and never in the old one');
  assert.ok(await ts.createStore('notes').get('n1'), 'whose documents stay where they were');
});

test('removing a def from before 0.5.0 that never moved says its documents are orphaned', async () => {
  const h = host();
  const ts = h.machineOf('@x/tool-store');
  await ts.createStore('store_tools').set('jots', legacyDef('jots'));
  await ts.createStore('jots').set('j1', { id: 'j1', version: 'a', fact: 'left' });
  await plugin.setup!(ts);
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: unknown) => { warned.push(String(m)); };
  try {
    const r = await call(h.tools.get('store_action')!, { action: 'remove', name: 'jots' });
    assert.deepEqual(r.result, { removed: true });
  } finally { console.warn = warn; }
  assert.ok(warned.some(m => /"jots" was removed before it moved out of the namespace "jots".*orphaned/.test(m)));
  assert.ok(await ts.createStore('jots').get('j1'), 'the documents are where they were');
});

// A def from before 0.5.0 is registered by this plugin's boot under whatever was true then, and what is true
// now can differ by process and by principal, so a call may only act on the def as it stands.

/** Stores keyed by namespace and, unless the namespace is in `shared`, by whoever `as` says is calling, as a
 *  principal-partitioned backend does. */
function partitioned(h: ReturnType<typeof host>) {
  let who = 'a';
  const byPrincipal = new Map<string, Store<Doc>>();
  const forWho = (ns: string) => {
    const key = `${who}\0${ns}`;
    let s = byPrincipal.get(key);
    if (!s) byPrincipal.set(key, s = memoryStore());
    return s;
  };
  const createStore = (ns: string): Store<Doc> => new Proxy({}, { get: (_, m: string) => (...a: unknown[]) => (forWho(ns) as unknown as Record<string, (...x: unknown[]) => unknown>)[m]!(...a) }) as Store<Doc>;
  const as = async <T>(principal: string, fn: () => Promise<T>): Promise<T> => { const was = who; who = principal; try { return await fn(); } finally { who = was; } };
  const machine = { ...h.machineOf('@x/tool-store'), createStore } as MatbotMachine;
  return { as, machine, createStore };
}

async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; warned: string[] }> {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: unknown) => { warned.push(String(m)); };
  try { return { value: await fn(), warned }; } finally { console.warn = warn; }
}

test('a def another process has moved is served from where it moved to, not the namespace it was booted with', async () => {
  const h = host();
  const ts = h.machineOf('@x/tool-store');
  const meta = ts.createStore('store_tools');
  await meta.set('notes', legacyDef('notes'));
  await ts.createStore('notes').set('old', { id: 'old', version: 'a', fact: 'stale copy' });
  await plugin.setup!(ts);
  // The other process, between this one's boot and its first call.
  await ts.createStore('store-notes').set('n1', { id: 'n1', version: 'a', fact: 'moved' });
  await meta.set('notes', { ...legacyDef('notes'), version: 'v1', namespace: 'store-notes' });

  const tool = h.tools.get('notes_action')!;
  assert.equal(((await call(tool, { action: 'get', id: 'n1' })).result as { fact?: string } | null)?.fact, 'moved');
  await call(tool, { action: 'set', id: 'n2', data: { fact: 'new' } });
  assert.ok(await ts.createStore('store-notes').get('n2'), 'writes land with the rest');
  assert.equal(await ts.createStore('notes').get('n2'), null, 'and do not diverge into the old namespace');
});

test('a move that loses its compare-and-swap uses the def that won, on this call and the next', async () => {
  const h = host();
  const ts = h.machineOf('@x/tool-store');
  const meta = ts.createStore('store_tools');
  await meta.set('notes', legacyDef('notes'));
  await plugin.setup!(ts);
  // Another process moves it after this call has read the def and before it writes.
  const realCas = meta.cas.bind(meta);
  meta.cas = (async (id: string) => {
    await meta.set(id, { ...legacyDef('notes'), version: 'other', namespace: 'store-notes', description: 'theirs' });
    meta.cas = realCas;
    return { ok: false, current: await meta.get(id) };
  }) as typeof meta.cas;
  const tool = h.tools.get('notes_action')!;
  await call(tool, { action: 'set', id: 'n1', data: { fact: 'one' } });
  await call(tool, { action: 'set', id: 'n2', data: { fact: 'two' } });
  assert.ok(await ts.createStore('store-notes').get('n1'));
  assert.ok(await ts.createStore('store-notes').get('n2'));
  assert.equal(await ts.createStore('notes').get('n1'), null);
  assert.equal((await meta.get('notes') as { description?: string } | null)?.description, 'theirs', 'and leaves it as it was won');
});

test('a def its owner has taken in another process is not served by the tool booted before that', async () => {
  const h = host();
  const ts = h.machineOf('@x/tool-store');
  const meta = ts.createStore('store_tools');
  await meta.set('remembered_facts', legacyDef('remembered_facts'));
  await ts.createStore('remembered_facts').set('f1', { id: 'f1', version: 'a', fact: 'the owner\'s' });
  await plugin.setup!(ts);
  await meta.set('remembered_facts', { ...legacyDef('remembered_facts'), version: 'v1', owner: '@x/cognition' });
  const got = await call(h.tools.get('remembered_facts_action')!, { action: 'get', id: 'f1' });
  assert.match(got.error ?? '', /belongs to the plugin "@x\/cognition"/);
  assert.equal(got.result, undefined);
});

test('a move that fails is not remembered: the next call tries again', async () => {
  const h = host();
  const ts = h.machineOf('@x/tool-store');
  await ts.createStore('store_tools').set('notes', legacyDef('notes'));
  await ts.createStore('notes').set('n1', { id: 'n1', version: 'a', fact: 'kept' });
  await plugin.setup!(ts);
  const from = ts.createStore('notes');
  const query = from.query.bind(from);
  from.query = (async () => { from.query = query; throw new Error('backend hiccup'); }) as typeof from.query;
  const tool = h.tools.get('notes_action')!;
  await assert.rejects(call(tool, { action: 'get', id: 'n1' }), /backend hiccup/, 'the failure reaches this caller');
  const { value, warned } = await quietly(() => call(tool, { action: 'get', id: 'n1' }));
  assert.equal((value.result as { fact?: string } | null)?.fact, 'kept', 'without a restart');
  assert.ok(warned.some(m => /"store-notes" \(1 copied\)/.test(m)));
});

test('each principal\'s def is moved with that principal\'s documents, whoever called first', async () => {
  const h = host();
  const { as, machine, createStore } = partitioned(h);
  for (const who of ['a', 'b']) {
    await as(who, async () => {
      await createStore('store_tools').set('notes', legacyDef('notes'));
      await createStore('notes').set(`${who}-doc`, { id: `${who}-doc`, version: 'a', fact: who });
    });
  }
  await plugin.setup!(machine);
  const tool = () => h.tools.get('notes_action')!;
  await quietly(() => as('a', () => call(tool(), { action: 'get', id: 'a-doc' })));
  const { value: b } = await quietly(() => as('b', () => call(tool(), { action: 'get', id: 'b-doc' })));
  assert.equal((b.result as { fact?: string } | null)?.fact, 'b', 'not lost because someone else moved first');
  await as('b', async () => {
    assert.equal((await createStore('store_tools').get('notes') as { namespace?: string } | null)?.namespace, 'store-notes');
    assert.ok(await createStore('store-notes').get('b-doc'));
    assert.equal(await createStore('store-notes').get('a-doc'), null, 'nor mixed with theirs');
  });
});

test('a caller with no def of the store does not fix the tool as legacy for one who has', async () => {
  const h = host();
  const { as, machine, createStore } = partitioned(h);
  await as('a', async () => {
    await createStore('store_tools').set('notes', legacyDef('notes'));
    await createStore('notes').set('a-doc', { id: 'a-doc', version: 'a', fact: 'a' });
  });
  await as('a', () => plugin.setup!(machine) as Promise<void>);
  const tool = () => h.tools.get('notes_action')!;
  // First caller: nothing recorded. It may not write into a namespace named after the store, which a plugin may own.
  await as('b', () => call(tool(), { action: 'set', id: 'b-doc', data: { fact: 'b' } }));
  await as('b', async () => {
    assert.ok(await createStore('store-notes').get('b-doc'));
    assert.equal(await createStore('notes').get('b-doc'), null);
    assert.equal(await createStore('store_tools').get('notes'), null, 'and it is given no def');
  });
  const { value: a } = await quietly(() => as('a', () => call(tool(), { action: 'get', id: 'a-doc' })));
  assert.equal((a.result as { fact?: string } | null)?.fact, 'a', 'the one who has a def still has it moved');
  await as('a', async () => assert.equal((await createStore('store_tools').get('notes') as { namespace?: string } | null)?.namespace, 'store-notes'));
});

test('a def shared in read-only cannot be moved, and the call still works, on the caller\'s own copy', async () => {
  const h = host();
  const ts = h.machineOf('@x/tool-store');
  const meta = ts.createStore('store_tools');
  await meta.set('notes', legacyDef('notes'));
  await ts.createStore('notes').set('n1', { id: 'n1', version: 'a', fact: 'kept' });
  await plugin.setup!(ts);
  meta.cas = (async () => { throw readOnlyError('store_tools', 'notes', 'someone'); }) as typeof meta.cas;
  const tool = h.tools.get('notes_action')!;
  const got = await call(tool, { action: 'get', id: 'n1' });
  assert.equal((got.result as { fact?: string } | null)?.fact, 'kept');
  await call(tool, { action: 'set', id: 'n2', data: { fact: 'new' } });
  assert.ok(await ts.createStore('store-notes').get('n2'), 'in tool-store\'s namespace, which is the point of moving');
  assert.equal(await ts.createStore('notes').get('n2'), null);
});

test('an unowned def in tool-store\'s namespace (already moved, or a model\'s) is handed to the owner when it defines that name', async () => {
  const h = host();
  const ts = h.machineOf('@x/tool-store');
  await ts.createStore('store_tools').set('remembered_facts', { ...legacyDef('remembered_facts'), namespace: 'store-remembered_facts' });
  await ts.createStore('store-remembered_facts').set('m1', { id: 'm1', version: 'a', fact: 'the model\'s' });
  await plugin.setup!(ts);
  assert.equal(h.tools.get('remembered_facts_action')?.pluginName, '@x/tool-store');

  await defineStore(h.machineOf('@x/cognition'), spec);
  assert.deepEqual([h.collisions, h.refusals], [[], []]);
  assert.equal(h.tools.get('remembered_facts_action')?.pluginName, '@x/cognition');
  await ts.createStore('remembered_facts').set('f1', { id: 'f1', version: 'a', fact: 'the owner\'s' });
  const got = await call(h.tools.get('remembered_facts_action')!, { action: 'get', id: 'f1' });
  assert.equal((got.result as { fact?: string } | null)?.fact, 'the owner\'s', 'the tool serves the owner\'s namespace, not store-');
  assert.ok(await ts.createStore('store-remembered_facts').get('m1'), 'and the model\'s documents stay in their own');
});

test('another plugin\'s def of the name is not taken over: that is still a collision for the host to decide', async () => {
  const h = host();
  await plugin.setup!(h.machineOf('@x/tool-store'));
  await defineStore(h.machineOf('@x/cognition'), spec);
  await defineStore(h.machineOf('@x/other'), spec);
  assert.deepEqual(h.collisions, ['remembered_facts_action']);
});
