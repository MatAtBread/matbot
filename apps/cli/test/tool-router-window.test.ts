import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MatbotMachine, Message, MessageContent, Tool, ToolPresenter } from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { plugin } from '../../../plugins/tool-router/src/index.ts';

const tool = (name: string): Tool => ({
  name,
  description: `Does the ${name} thing`,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  executor: { async *execute() { return undefined; } },
} as unknown as Tool);

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

interface Booted { presenter: ToolPresenter; tools: Tool[]; asked: string[]; store: MemoryStore<any> }

async function boot(names: string[], opts: { reply?: (name: string) => string; store?: MemoryStore<any>; sub?: boolean } = {}): Promise<Booted> {
  const tools = new Map(names.map(n => [n, tool(n)]));
  const store = opts.store ?? new MemoryStore();
  const asked: string[] = [];
  let presenter: ToolPresenter | undefined;
  const services = {
    isSubAgent:  () => opts.sub === true,
    createStore: (ns: string) => (ns === 'tool_router_nouns' ? store : new MemoryStore()),
    settings:    () => ({ get: async () => undefined, entries: async () => ({}), set: async () => {}, delete: async () => {} }),
    providers:   new Map([['p', {}]]),
    register:    async (key: string, value: unknown) => { if (key === 'ToolPresenter') presenter = value as ToolPresenter; },
    singleTurn:  async ({ prompt }: { prompt: string }) => {
      const name = prompt.slice(0, prompt.indexOf(':'));
      asked.push(name);
      return { text: opts.reply?.(name) ?? 'NOUNS: things\nWIDTH: specific' };
    },
    Notifier:    { consume: () => {} },
    tools: {
      list:     () => [...tools.values()],
      resolve:  (n: string) => tools.get(n),
      register: (t: Tool) => { tools.set(t.name, t); },
    },
  } as unknown as MatbotMachine;
  const warn = console.warn;
  console.warn = () => {};
  try { await plugin.setup!(services); await settle(); } finally { console.warn = warn; }
  return { presenter: presenter!, tools: [...tools.values()], asked, store };
}

let n = 0;
const message = (role: Message['role'], content: MessageContent[]): Message =>
  ({ id: `m${n++}`, role, content, createdAt: new Date(0).toISOString(), traceId: 't' }) as Message;
const found = (names: string[], fallbacks: string[] = []) =>
  ({ found: [...names.map(name => ({ name })), ...fallbacks.map(name => ({ name, fallback: true }))], note: '' });

const window = async (b: Booted, messages: Message[]): Promise<string[]> =>
  (await b.presenter.present(b.tools, { session: { id: 's', messages } as never, provider: 'p' })).map(t => t.name);

const LIBRARY = [
  'named', ...Array.from({ length: 30 }, (_, i) => `broad_${i}`), ...Array.from({ length: 12 }, (_, i) => `pin_${i}`),
  ...Array.from({ length: 10 }, (_, i) => `other_${i}`),
];

test('searches made together are one moment: each one\'s best survives the cull, fallbacks go first', async () => {
  const b = await boot(LIBRARY);
  const pins = Array.from({ length: 12 }, (_, i) => `pin_${i}`);
  const broad = Array.from({ length: 20 }, (_, i) => `broad_${i}`);
  // One search for a tool by name, one broad, in the same message; each result trails the fallbacks.
  const w = await window(b, [
    message('user', [{ type: 'text', text: 'use the named tool' }]),
    message('assistant', [
      { type: 'tool-call', id: 's1', name: 'tool_search', input: { query: 'named' } },
      { type: 'tool-call', id: 's2', name: 'tool_search', input: { query: 'broad things' } },
    ]),
    message('tool', [
      { type: 'tool-result', id: 's1', result: found(['named'], pins) },
      { type: 'tool-result', id: 's2', result: found(broad, pins) },
    ]),
  ]);
  assert.ok(w.includes('named'), `the first search's top hit stays: ${w.join(', ')}`);
  assert.ok(w.includes('broad_0'), 'and so does the second\'s');
  assert.ok(!w.some(x => x.startsWith('pin_')), `real matches outrank every fallback: ${w.join(', ')}`);
});

test('a later batch outranks an earlier one, and a result recorded without the flag reads as matches', async () => {
  const b = await boot(LIBRARY);
  const broad = Array.from({ length: 25 }, (_, i) => `broad_${i}`);
  const w = await window(b, [
    message('assistant', [{ type: 'tool-call', id: 'a', name: 'other_0', input: {} }]),
    message('tool', [{ type: 'tool-result', id: 'a', result: 1 }]),
    message('assistant', [{ type: 'tool-call', id: 's1', name: 'tool_search', input: { query: 'x' } }]),
    message('tool', [{ type: 'tool-result', id: 's1', result: { found: broad.map(name => ({ name })), note: '' } }]),
  ]);
  assert.ok(w.includes('broad_0') && w.includes('broad_10'), w.join(', '));
  assert.ok(!w.includes('broad_24'), 'the tail of a long search is shed');
  assert.ok(!w.includes('other_0'), 'a call older than the search ranks below its best matches');
});

test('a width judged under an earlier rule is judged again once, keeping its nouns; a sub-agent keeps it as it is', async () => {
  const store = new MemoryStore<any>();
  const first = await boot(['sleep'], { store, reply: () => 'NOUNS: milliseconds\nWIDTH: open' });
  const [rec] = (await store.query({})).items;
  assert.equal(rec.specificity, 'open');
  // As a record written before the rule was versioned.
  const { widthRule: _, ...old } = rec;
  await store.set(rec.id, old);

  const sub = await boot(['sleep'], { store, sub: true });
  assert.deepEqual(sub.asked, [], 'a sub-agent reads the cache only');
  assert.ok((await window(sub, [])).includes('sleep'));

  const again = await boot(['sleep'], { store, reply: () => 'NOUNS: something else\nWIDTH: specific' });
  assert.deepEqual(again.asked, ['sleep']);
  const [now] = (await store.query({})).items;
  assert.equal(now.specificity, 'specific');
  assert.equal(now.nouns, 'milliseconds', 'the nouns are kept');
  assert.equal(typeof now.widthRule, 'number');

  const settled = await boot(['sleep'], { store });
  assert.deepEqual(settled.asked, [], 'a verdict under the current rule is not asked again');
  void first;
});

test('a width that could not be judged again keeps the earlier verdict and is asked again next time', async () => {
  const store = new MemoryStore<any>();
  await boot(['http'], { store, reply: () => 'NOUNS: URLs\nWIDTH: open' });
  const [rec] = (await store.query({})).items;
  const { widthRule: _, ...old } = rec;
  await store.set(rec.id, old);

  const garbled = await boot(['http'], { store, reply: () => 'I cannot help with that' });
  assert.deepEqual(garbled.asked, ['http']);
  const [kept] = (await store.query({})).items;
  assert.equal(kept.specificity, 'open');
  assert.equal(kept.widthRule, undefined);

  const next = await boot(['http'], { store, reply: () => 'NOUNS: URLs\nWIDTH: open' });
  assert.deepEqual(next.asked, ['http']);
});
