import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleMachine, ProviderRegistryImpl, installPrincipalCarrier, createConstantPrincipalCarrier, installUsageCarrier,
  createSession, invokeTool, toolResult,
} from '@matatbread/matbot-core';
import type { CompletionEvent, MatbotPlugin, Message, ProviderAdapter, Session, Tool, ToolContext } from '@matatbread/matbot-core';
import { createAlsUsageCarrier } from '@matatbread/matbot-host-node';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';
import { plugin, MAX_CONCURRENT_TURNS, type WaveStarted } from '@matatbread/matbot-parallel-map-reduce';

installPrincipalCarrier(createConstantPrincipalCarrier({ id: 'tester', type: 'user' }));
installUsageCarrier(createAlsUsageCarrier());

type Script = (prompt: string, messages: readonly Message[]) => CompletionEvent[] | Promise<CompletionEvent[]>;

const says = (text: string): CompletionEvent[] => [{ type: 'text-delta', delta: text }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'done' }];
const calls = (name: string): CompletionEvent[] => [{ type: 'tool-call', id: crypto.randomUUID(), name, input: {} }, { type: 'done' }];
const textOf = (m: Message): string => m.content.flatMap(c => (c.type === 'text' ? [c.text] : [])).join('');
const promptOf = (messages: readonly Message[]): string => {
  const user = messages.findLast(m => m.role === 'user');
  return (user?.content ?? []).flatMap(c => (c.type === 'text' ? [c.text] : [])).join('\n');
};
const answered = (messages: readonly Message[]): boolean => messages.at(-1)?.role === 'tool';
const isReduce = (prompt: string): boolean => /\[w-\w+: \d+ of \d+/.test(prompt);

async function machine(t: { after(fn: () => Promise<void>): void }, script: Script, extraTools: Tool[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-pmr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      return (async function* () { yield* await script(promptOf(messages), messages); })();
    },
  };
  const { services, dispose } = assembleMachine({
    bootBackend: new FilesystemStorageBackend(join(dir, 'boot')),
    vault:       { resolve: async (ref: string) => ref } as never,
    providers:   new ProviderRegistryImpl([['fake', { name: 'fake', module: 'fake-adapter', model: 'fake' }]]),
    version:     '9.9.9',
    host: () => ({
      loadPlugin:   async () => ({ provider: () => adapter }) as unknown as MatbotPlugin,
      unloadPlugin: async () => false,
      isSubAgent:   () => false,
      TypeScriptStripper: { strip: (s: string) => s },
    }),
  });
  t.after(dispose);
  await plugin.setup!(services);
  for (const tool of extraTools) services.tools.register(tool);
  const session = createSession();
  await services.sessions.set(session.id, session);
  return { services, session };
}
type M = Awaited<ReturnType<typeof machine>>;

const start = (m: M, input: unknown, opts: { session?: Session; signal?: AbortSignal } = {}) =>
  toolResult(invokeTool(m.services, 'parallel_map_reduce', input as never, {
    session: opts.session ?? m.session, signal: opts.signal ?? new AbortController().signal, provider: 'fake',
  })) as Promise<WaveStarted>;

async function until(m: M, id: string, done: (messages: Message[]) => boolean): Promise<Message[]> {
  for (let i = 0; i < 500; i++) {
    const messages = (await m.services.sessions.get(id))?.messages ?? [];
    if (done(messages)) return messages;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timed out: ${JSON.stringify((await m.services.sessions.get(id))?.messages.map(textOf))}`);
}
const finished = (messages: Message[]): boolean => messages.some(x => x.role === 'assistant' && textOf(x) === 'combined');

test('it returns at once; each answer is appended under its item, then the reduce is asked with the tally and answered', { timeout: 15000 }, async t => {
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const m = await machine(t, async prompt => {
    if (isReduce(prompt)) return says('combined');
    await held;
    return says(`answer for ${prompt.split('\n').at(-1)}`);
  });
  const started = await start(m, { mapPrompt: 'Look at this.', items: ['item a', 'item b'], reducePrompt: 'Combine them.' });
  assert.match(started.wave, /^w-/);
  assert.deepEqual({ ...started, wave: '' }, { wave: '', started: 2, session: m.session.id }, 'it returned before any turn finished');
  release();
  const messages = await until(m, m.session.id, finished);
  const texts = messages.map(textOf);
  const ask = messages.findIndex(x => x.role === 'user');
  assert.ok(ask > 0, texts.join('\n'));
  assert.deepEqual(new Set(texts.slice(0, ask)), new Set([`[${started.wave} 1/2 item a] answer for item a`, `[${started.wave} 2/2 item b] answer for item b`]));
  assert.equal(texts[ask], `[${started.wave}: 2 of 2 answered] Combine them.`);
  assert.deepEqual(messages[ask]!.metadata?.['roboSubmit'], { from: `parallel_map_reduce wave ${started.wave}` });
});

test('a failed turn is appended as a failure and named in the tally', { timeout: 15000 }, async t => {
  const m = await machine(t, prompt => {
    if (isReduce(prompt)) return says('combined');
    if (prompt.endsWith('bad')) throw new Error('the endpoint refused');
    return says('fine');
  });
  const { wave } = await start(m, { mapPrompt: 'Try.', items: ['good', 'bad'], reducePrompt: 'Combine.', tools: false });
  const texts = (await until(m, m.session.id, finished)).map(textOf);
  assert.ok(texts.some(x => x.startsWith(`[${wave} 2/2 bad] failed:`) && x.includes('the endpoint refused')), texts.join('\n'));
  assert.ok(texts.includes(`[${wave}: 1 of 2 answered; failed: bad] Combine.`), texts.join('\n'));
});

test('a turn acts with tools unless told not to', { timeout: 15000 }, async t => {
  const acted: string[] = [];
  const look = { name: 'look', description: 'look', inputSchema: { type: 'object' },
    executor: { async *execute(_i: unknown, _ctx: ToolContext) { acted.push('look'); yield { type: 'result' as const, value: 1 }; } } } as Tool;
  const m = await machine(t, (prompt, messages) => {
    if (isReduce(prompt)) return says('combined');
    if (answered(messages)) return says('looked');
    // Only a sub-turn can call a tool; it opens with the line saying it is working for another agent.
    return prompt.includes('another agent') ? calls('look') : says('said');
  }, [look]);
  await start(m, { mapPrompt: 'Do it.', items: ['act'], reducePrompt: 'Combine.' });
  await until(m, m.session.id, finished);
  assert.deepEqual(acted, ['look'], 'tools by default');

  const other = createSession();
  await m.services.sessions.set(other.id, other);
  await start(m, { mapPrompt: 'Do it.', items: ['act'], reducePrompt: 'Combine.', tools: false }, { session: other });
  const texts = (await until(m, other.id, finished)).map(textOf);
  assert.ok(texts.some(x => x.endsWith('] said')), texts.join('\n'));
  assert.deepEqual(acted, ['look'], 'and none with tools: false');
});

test(`at most ${MAX_CONCURRENT_TURNS} of a wave's turns run at once`, { timeout: 15000 }, async t => {
  let running = 0, peak = 0;
  const m = await machine(t, async prompt => {
    if (isReduce(prompt)) return says('combined');
    peak = Math.max(peak, ++running);
    await new Promise(r => setTimeout(r, 20));
    running--;
    return says('ok');
  });
  const n = MAX_CONCURRENT_TURNS + 3;
  await start(m, { mapPrompt: 'Go.', items: Array.from({ length: n }, (_, i) => `p${i}`), reducePrompt: 'Combine.', tools: false });
  const texts = (await until(m, m.session.id, finished)).map(textOf);
  assert.equal(peak, MAX_CONCURRENT_TURNS);
  assert.ok(texts.some(x => x.includes(`${n} of ${n} answered`)), texts.join('\n'));
});

test('concurrency sets how many turns run at once', { timeout: 15000 }, async t => {
  let running = 0, peak = 0;
  const m = await machine(t, async prompt => {
    if (isReduce(prompt)) return says('combined');
    peak = Math.max(peak, ++running);
    await new Promise(r => setTimeout(r, 20));
    running--;
    return says('ok');
  });
  await start(m, { mapPrompt: 'Go.', items: Array.from({ length: 6 }, (_, i) => `p${i}`), reducePrompt: 'Combine.', tools: false, concurrency: 2 });
  await until(m, m.session.id, finished);
  assert.equal(peak, 2);
});

test('it reports to a conversation it names, and one with none of its own must name one', { timeout: 15000 }, async t => {
  const m = await machine(t, prompt => says(isReduce(prompt) ? 'combined' : 'ok'));
  const other = createSession();
  await m.services.sessions.set(other.id, other);
  const started = await start(m, { mapPrompt: 'Go.', items: ['a'], reducePrompt: 'Combine.', session: other.id, tools: false });
  assert.equal(started.session, other.id);
  await until(m, other.id, finished);
  assert.deepEqual((await m.services.sessions.get(m.session.id))?.messages, [], 'nothing in the calling conversation');

  const door = { ...createSession(), id: '#http' } as Session;
  await assert.rejects(start(m, { mapPrompt: 'Go.', items: ['a'], reducePrompt: 'Combine.' }, { session: door }), /name the one to append to/);
});

test('a bad call is refused before any turn runs', { timeout: 15000 }, async t => {
  let called = 0;
  const m = await machine(t, () => { called++; return says('x'); });
  const refused = (input: unknown, why: RegExp) => assert.rejects(start(m, input), why);
  await refused({ mapPrompt: 'm', items: ['a'] }, /"reducePrompt"/);
  await refused({ items: ['a'], reducePrompt: 'r' }, /"mapPrompt"/);
  await refused({ mapPrompt: 'm', items: [], reducePrompt: 'r' }, /at least one item/);
  await refused({ mapPrompt: 'm', items: ['a', ' '], reducePrompt: 'r' }, /Item 2 is empty/);
  await refused({ mapPrompt: 'm', items: [{ attach: 'x', label: 'y' }], reducePrompt: 'r' }, /Item 1 is neither text nor/);
  await refused({ mapPrompt: 'm', items: [3], reducePrompt: 'r' }, /Item 1 is neither text nor/);
  await refused({ mapPrompt: 'm', items: ['a'], reducePrompt: 'r', context: 'x' }, /Unknown field "context"/);
  await refused({ mapPrompt: 'm', items: ['a'], reducePrompt: 'r', concurrency: 0 }, /"concurrency"/);
  await refused({ mapPrompt: 'm', items: ['a'], reducePrompt: 'r', concurrency: 2.5 }, /"concurrency"/);
  assert.equal(called, 0);
});

test('stopping the calling turn stops the wave: what finished stays, it says so, and the reduce is not asked', { timeout: 15000 }, async t => {
  let blocked = 0;
  let allIn!: () => void;
  const in4 = new Promise<void>(r => { allIn = r; });
  const block = { name: 'block', description: 'block', inputSchema: { type: 'object' },
    executor: { async *execute(_i: unknown, ctx: ToolContext) {
      if (++blocked === MAX_CONCURRENT_TURNS) allIn();
      await new Promise<void>(r => ctx.signal.addEventListener('abort', () => r(), { once: true }));
      yield { type: 'result' as const, value: 'stopped' };
    } } } as Tool;
  const m = await machine(t, (prompt, messages) => isReduce(prompt) ? says('combined') : answered(messages) ? says('done') : calls('block'), [block]);
  const ac = new AbortController();
  const { wave } = await start(m, { mapPrompt: 'Go.', items: Array.from({ length: MAX_CONCURRENT_TURNS + 2 }, (_, i) => `p${i}`), reducePrompt: 'Combine.' }, { signal: ac.signal });
  await in4;
  ac.abort();
  const messages = await until(m, m.session.id, ms => ms.some(x => textOf(x).startsWith(`[${wave}: stopped`)));
  assert.equal(blocked, MAX_CONCURRENT_TURNS, 'nothing more was started');
  assert.ok(!messages.some(x => x.role === 'user'), 'no reduce was asked');
});

test('each turn is asked the map prompt, then its item; a long item is shortened where it names its answer', { timeout: 15000 }, async t => {
  const asked: string[] = [];
  const m = await machine(t, prompt => {
    if (isReduce(prompt)) return says('combined');
    asked.push(prompt);
    return says('ok');
  });
  const long = 'Session ID: ' + 'x'.repeat(100);
  const { wave } = await start(m, { mapPrompt: 'Tag the conversation named below.', items: ['Session ID: c-01', long], reducePrompt: 'Group them.', tools: false });
  const texts = (await until(m, m.session.id, finished)).map(textOf);
  assert.deepEqual(asked.sort(), [`Tag the conversation named below.\n\n${long}`, 'Tag the conversation named below.\n\nSession ID: c-01'].sort());
  const row = texts.find(x => x.startsWith(`[${wave} 2/2 `))!;
  assert.match(row, /^\[w-\w+ 2\/2 Session ID: x{47}…\] ok$/);
});

test('a media item is attached to its turn and names its answer', { timeout: 15000 }, async t => {
  const m = await machine(t, prompt => says(isReduce(prompt) ? 'combined' : 'ok'));
  const { wave } = await start(m, { mapPrompt: 'Describe the image.', items: [{ attach: 'm-1#0' }], reducePrompt: 'Group them.' });
  const texts = (await until(m, m.session.id, finished)).map(textOf);
  // This conversation holds no such attachment, so the turn refuses it, and the failure names the item.
  assert.ok(texts.some(x => x.startsWith(`[${wave} 1/1 m-1#0] failed:`) && x.includes('is not an attachment of this conversation')), texts.join('\n'));
  assert.ok(texts.includes(`[${wave}: 0 of 1 answered; failed: m-1#0] Group them.`), texts.join('\n'));
});
