import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleMachine, ProviderRegistryImpl, installPrincipalCarrier, createConstantPrincipalCarrier, installUsageCarrier,
  createSession, invokeTool, toolResult, usageEntries, subTurnDepth, MAX_CONCURRENT_TURNS, MAX_SUB_TURN_DEPTH, callFramesOf,
} from '@matatbread/matbot-core';
import type {
  CompletionEvent, FormField, MatbotPlugin, Message, ProviderAdapter, PromptFn, Session, Tool, ToolContext, SubTurnResult,
} from '@matatbread/matbot-core';
import { createAlsUsageCarrier } from '@matatbread/matbot-host-node';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';

installPrincipalCarrier(createConstantPrincipalCarrier({ id: 'tester', type: 'user' }));
installUsageCarrier(createAlsUsageCarrier());

type Script = (prompt: string, messages: readonly Message[]) => CompletionEvent[] | Promise<CompletionEvent[]>;

const says = (text: string): CompletionEvent[] => [
  { type: 'text-delta', delta: text },
  { type: 'usage', inputTokens: 10, outputTokens: 1 },
  { type: 'done' },
];
const calls = (name: string, input: unknown = {}): CompletionEvent[] => [
  { type: 'tool-call', id: crypto.randomUUID(), name, input },
  { type: 'usage', inputTokens: 10, outputTokens: 1 },
  { type: 'done' },
];

// Which turn a call belongs to, read as a model would: the last text of the last user message is its prompt.
const promptOf = (messages: readonly Message[]): string => {
  const user = messages.findLast(m => m.role === 'user');
  return (user?.content ?? []).flatMap(c => (c.type === 'text' ? [c.text] : [])).at(-1) ?? '';
};
const answered = (messages: readonly Message[]): boolean => messages.at(-1)?.role === 'tool';

async function machine(t: { after(fn: () => Promise<void>): void }, script: Script, extraTools: Tool[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'matbot-single-turn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen: Array<readonly Message[]> = [];
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      seen.push(messages);
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
  for (const tool of extraTools) services.tools.register(tool);
  const session = createSession();
  await services.sessions.set(session.id, session);
  return { services, session, seen };
}

type M = Awaited<ReturnType<typeof machine>>;
const invoke = (m: M, session: Session, input: unknown, opts: { signal?: AbortSignal; prompt?: PromptFn } = {}) =>
  toolResult(invokeTool(m.services, 'single_turn', input as never, {
    session, signal: opts.signal ?? new AbortController().signal, provider: 'fake',
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
  }));
const many = (m: M, session: Session, turns: unknown[], opts: { signal?: AbortSignal; prompt?: PromptFn } = {}) =>
  invoke(m, session, { turns }, opts) as Promise<SubTurnResult[]>;

const acting = (prompt: string): { prompt: string; context: string; tools: true } => ({ prompt, context: 'ctx', tools: true });
const tool = (name: string, execute: (input: unknown, ctx: ToolContext) => AsyncGenerator<never | { type: 'result'; value: unknown }>): Tool => ({
  name, description: name, inputSchema: { type: 'object' }, executor: { execute: execute as never },
});

test('one turn without tools is one request, sent its context before its task, with its system prompt', async t => {
  const m = await machine(t, prompt => says(`answer to ${prompt}`));
  const r = await invoke(m, m.session, { prompt: 'the task', context: 'the brief', system: 'be terse' });
  assert.deepEqual(r, { ok: true, text: 'answer to the task' }, 'spend is on the ledger, not in the result');
  assert.equal(m.seen.length, 1);
  const wire = JSON.stringify(m.seen[0]);
  assert.ok(wire.indexOf('the brief') < wire.indexOf('the task'));
  assert.match(wire, /be terse/);
});

test('turns come back in the order they were given, with and without tools in one call', async t => {
  const m = await machine(t, (prompt, messages) => answered(messages) ? says(`acted on ${prompt}`) : prompt === 'act' ? calls('noop') : says(`answer to ${prompt}`),
    [tool('noop', async function* () { yield { type: 'result', value: 1 }; })]);
  const r = await many(m, m.session, [{ prompt: 'say' }, acting('act')]);
  assert.equal(r.length, 2);
  assert.ok(r[0]!.ok && !('toolCalls' in r[0]!), JSON.stringify(r[0]));
  assert.equal(r[0]!.ok && r[0]!.text, 'answer to say');
  assert.deepEqual(r[1]!.ok && 'toolCalls' in r[1]! && r[1]!.toolCalls.map(c => c.name), ['noop']);
});

// How a model writes "all of these act": once, beside the turns. Refused, it read as "tools off" to anyone
// grading the call, and was the one way models got the flag wrong.
test('a field beside turns applies to every turn: context adds to each turn\'s own, the rest are defaults', { timeout: 15000 }, async t => {
  const m = await machine(t, (prompt, messages) => answered(messages) ? says('done') : prompt === 'plain' ? says('said') : calls('noop'),
    [tool('noop', async function* () { yield { type: 'result', value: 1 }; })]);
  const r = await invoke(m, m.session, { tools: true, context: 'SHARED', turns: [{ prompt: 'a' }, { prompt: 'b', context: 'OWN' }, { prompt: 'plain', tools: false }] }) as SubTurnResult[];
  assert.deepEqual(r.map(x => x.ok && 'toolCalls' in x), [true, true, false]);
  const wire = (p: string): string => JSON.stringify(m.seen.find(messages => promptOf(messages) === p));
  assert.ok(wire('a').includes('SHARED'));
  assert.ok(wire('b').indexOf('SHARED') < wire('b').indexOf('OWN'), 'everyone\'s context first, then the turn\'s own');
});

test('the turns genuinely overlap, which neither could survive if they ran in order', { timeout: 15000 }, async t => {
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const rendezvous = tool('rendezvous', async function* () {
    if (++arrived === 2) release();
    await Promise.race([both, new Promise((_, no) => setTimeout(() => no(new Error('the other turn never arrived')), 5000))]);
    yield { type: 'result', value: 'met' };
  });
  const m = await machine(t, (_p, messages) => answered(messages) ? says('done') : calls('rendezvous'), [rendezvous]);
  const r = await many(m, m.session, [acting('a'), acting('b')]);
  assert.ok(r.every(x => x.ok), JSON.stringify(r));
  assert.deepEqual(r[0]!.ok && 'toolCalls' in r[0]! && r[0]!.toolCalls.map(c => [c.name, c.isError]), [['rendezvous', false]]);
});

test(`at most ${MAX_CONCURRENT_TURNS} of a call's turns run at once, and the rest wait rather than fail`, { timeout: 15000 }, async t => {
  let running = 0, peak = 0;
  const m = await machine(t, async () => {
    peak = Math.max(peak, ++running);
    await new Promise(r => setTimeout(r, 30));
    running--;
    return says('done');
  });
  const r = await many(m, m.session, Array.from({ length: MAX_CONCURRENT_TURNS + 3 }, (_, i) => ({ prompt: `p${i}` })));
  assert.equal(peak, MAX_CONCURRENT_TURNS);
  assert.equal(r.filter(x => x.ok).length, MAX_CONCURRENT_TURNS + 3);
});

test('in turns, one failing leaves the others their results and says why; alone, it is the tool\'s error', { timeout: 15000 }, async t => {
  const m = await machine(t, prompt => { if (prompt.startsWith('bad')) throw new Error('the endpoint refused'); return says('fine'); });
  const r = await many(m, m.session, [{ prompt: 'good' }, { prompt: 'bad' }, acting('bad, acting')]);
  assert.deepEqual(r.map(x => x.ok), [true, false, false]);
  assert.match(!r[1]!.ok ? r[1]!.error : '', /the endpoint refused/);
  await assert.rejects(invoke(m, m.session, { prompt: 'bad' }), /the endpoint refused/);
});

test('a bad call is refused before any turn acts', { timeout: 15000 }, async t => {
  let called = 0;
  const m = await machine(t, () => { called++; return says('x'); });
  const refused = async (input: unknown, why: RegExp): Promise<void> => { await assert.rejects(invoke(m, m.session, input), why); };
  await refused({}, /non-empty string "prompt"/);
  await refused({ prompt: 'x', turns: [{ prompt: 'y' }] }, /each turn has its own "prompt"/);
  await refused({ turns: [{ prompt: 'y' }], provder: 'p' }, /"provder" beside "turns" is not a turn field/);
  await refused({ turns: [{ prompt: 'y', tools: true }], system: 's' }, /Turn 1 has "system", which only a turn without tools takes/);
  await refused({ turns: [] }, /at least one turn/);
  await refused({ turns: [{ prompt: 'a' }, 'b'] }, /Turn 2 is not a turn/);
  await refused({ turns: [{ prompt: 'a' }, { prompt: 'b', provder: 'p' }] }, /Turn 2 has an unknown field "provder"/);
  await refused({ turns: [{ prompt: 'a' }, { prompt: 'b', provider: 'nope' }] }, /unknown provider "nope".*fake/);
  await refused({ prompt: 'a', tools: true, system: 's' }, /only a turn without tools takes/);
  await refused({ prompt: 'a', transcript: true }, /only a turn with tools returns/);
  await refused({ prompt: 'a', tools: 'yes' }, /"tools" is true or false/);
  await refused({ turns: [{ prompt: 'a' }, { prompt: 'b', tools: true, attach: ['notes.txt'] }] }, /not an attachment of this conversation/);
  await refused({ prompt: 'a', attach: ['nothing.png'] }, /no such file/);
  assert.equal(called, 0);
});

test('a turn with tools writes nothing to the calling session', { timeout: 15000 }, async t => {
  const m = await machine(t, (_p, messages) => answered(messages) ? says('done') : calls('noop'), [tool('noop', async function* () { yield { type: 'result', value: 1 }; })]);
  const before = JSON.stringify(await m.services.sessions.get(m.session.id));
  await many(m, m.session, [acting('a'), acting('b')]);
  assert.equal(JSON.stringify(await m.services.sessions.get(m.session.id)), before);
});

test('a turn with tools does not see the conversation, is told the session it is in, and reads context before its task', { timeout: 15000 }, async t => {
  const m = await machine(t, () => says('x'));
  const session = { ...m.session, messages: [{ id: 'old', role: 'user', createdAt: '', traceId: 't', content: [{ type: 'text', text: 'SECRET HISTORY' }] }] } as Session;
  await invoke(m, session, { prompt: 'the task', context: 'the brief', tools: true });
  const wire = JSON.stringify(m.seen[0]);
  assert.doesNotMatch(wire, /SECRET HISTORY/);
  assert.ok(wire.includes(session.id), 'it can find the conversation if it needs to');
  assert.ok(wire.indexOf('the brief') < wire.indexOf('the task'));
});

test('messages come back only when a turn asks, and hold only that turn\'s own work', { timeout: 15000 }, async t => {
  const m = await machine(t, () => says('x'));
  const session = { ...m.session, messages: [{ id: 'carried', role: 'marker', createdAt: '', traceId: 't', content: [{ type: 'marker', creator: 'keep-me', data: 1 }] }] } as Session;
  const r = await many(m, session, [acting('a'), { ...acting('b'), transcript: true }]);
  assert.equal('messages' in r[0]!, false);
  const messages = r[1]!.ok && 'messages' in r[1]! ? r[1]!.messages : undefined;
  assert.ok(messages?.some(x => x.role === 'assistant'));
  assert.ok(!messages?.some(x => x.role === 'marker'), 'neither the copied markers nor the depth');
});

test('a turn with tools has the session\'s markers and knows it is a sub-turn, as its hooks do', { timeout: 15000 }, async t => {
  let inTurn: Session | undefined;
  const look = tool('look', async function* (_i, ctx) { inTurn = ctx.session; yield { type: 'result', value: 1 }; });
  const m = await machine(t, (_p, messages) => answered(messages) ? says('done') : calls('look'), [look]);
  const depths: Record<string, number> = {};
  m.services.hooks.register({ on: 'screen',   async handler(ctx) { depths['screen']   = subTurnDepth(ctx.session.messages); } });
  m.services.hooks.register({ on: 'followup', async handler(ctx) { depths['followup'] = subTurnDepth(ctx.session.messages); } });
  const session = { ...m.session, messages: [{ id: 'fn', role: 'marker', createdAt: '', traceId: 't', content: [{ type: 'marker', creator: 'keep-me', data: 1 }] }] } as Session;
  await invoke(m, session, acting('a'));
  assert.equal(inTurn?.id, session.id);
  assert.ok(inTurn?.messages.some(x => x.id === 'fn'));
  assert.deepEqual(depths, { screen: 1, followup: 1 });
});

// A sub-turn is part of the calling turn's work, so what its tools record about the session comes back as
// single_turn's own markers, for the runner to store. Core's record of the run (its depth) and what it was
// seeded with do not, and a turn that failed brings nothing.
test('what a turn\'s tools record comes back as the call\'s markers, in turn order; the run\'s own record does not', { timeout: 15000 }, async t => {
  const stash = tool('stash', async function* (input) {
    yield { type: 'marker', creator: 'probe', data: input } as never;
    yield { type: 'result', value: 1 };
  });
  const m = await machine(t, (prompt, messages) => {
    // The tool's marker message follows its result, so "answered" looks past markers.
    const done = messages.filter(x => x.role !== 'marker').at(-1)?.role === 'tool';
    if (prompt.startsWith('fail') && done) throw new Error('the endpoint refused');
    return done ? says('done') : calls('stash', { from: prompt });
  }, [stash]);
  const session = { ...m.session, messages: [{ id: 'fn', role: 'marker', createdAt: '', traceId: 't', content: [{ type: 'marker', creator: 'keep-me', data: 1 }] }] } as Session;
  const events = [];
  for await (const ev of invokeTool(m.services, 'single_turn', { turns: [acting('one'), { prompt: 'plain' }, acting('fail'), acting('two')] } as never, {
    session, signal: new AbortController().signal, provider: 'fake',
  })) events.push(ev);
  const markers = events.flatMap(e => e.type === 'marker' ? [[e.creator, e.data]] : []);
  assert.deepEqual(markers, [['probe', { from: 'one' }], ['probe', { from: 'two' }]]);
  assert.equal(events.at(-1)?.type, 'result', 'the markers precede the result');
  // Each keeps the frame its sub-turn's runner stamped (CallFrame), so the runner storing it puts
  // single_turn's own frame ahead of the call that recorded it, rather than losing where it came from.
  const frames = events.flatMap(e => e.type === 'marker' ? [callFramesOf(e)?.map(f => f.tool)] : []);
  assert.deepEqual(frames, [['stash'], ['stash']]);
});

// Through a body, as the tool's own test of the invariant: `ctx.session` is what carries the depth, so a
// nested call made with `invokeTool` counts the same as one the runner makes.
test(`depth stops at ${MAX_SUB_TURN_DEPTH}, through a composed call as well as a direct one`, { timeout: 20000 }, async t => {
  const reached: string[] = [];
  const composed = tool('composed', async function* (_i, ctx) {
    const r = await toolResult(invokeTool(m.services, 'single_turn', { prompt: 'level', tools: true }, { session: ctx.session, signal: ctx.signal, provider: 'fake' }));
    yield { type: 'result', value: r };
  });
  const m: M = await machine(t, (_prompt, messages) => {
    if (answered(messages)) { reached.push(JSON.stringify(messages.at(-1)!.content)); return says('done'); }
    return calls('composed');
  }, [composed]);
  await invoke(m, m.session, { prompt: 'level', tools: true });
  assert.ok(reached.some(x => /already 2 levels below/.test(x)), reached.join('\n'));
});

test('a parent\'s abort stops its turns', { timeout: 15000 }, async t => {
  let started!: () => void, aborted!: () => void;
  const start = new Promise<void>(r => { started = r; });
  const stop  = new Promise<void>(r => { aborted = r; });
  const block = tool('block', async function* (_i, ctx) {
    started();
    await new Promise<void>(r => ctx.signal.addEventListener('abort', () => r(), { once: true }));
    aborted();
    yield { type: 'result', value: 'stopped' };
  });
  const m = await machine(t, (_p, messages) => answered(messages) ? says('done') : calls('block'), [block]);
  const ac = new AbortController();
  const result = many(m, m.session, [acting('a')], { signal: ac.signal });
  await start;
  ac.abort();
  await stop;
  const r = await result;
  assert.equal(r[0]!.ok, false);
});

test('a turn appends as any turn does: to the calling conversation by default, directly or from a composed call', { timeout: 15000 }, async t => {
  // Returning a value and writing to a conversation are different acts ("append the time here and return
  // nothing"), so a sub-turn's append is not refused. It used to be, as a report its caller would relay anyway.
  const tell = tool('tell', async function* (_i, ctx) {
    await ctx.appender!.append(undefined, [{ role: 'assistant', content: [{ type: 'text', text: 'noted' }] }]);
    yield { type: 'result', value: 1 };
  });
  const viaBody = tool('via_body', async function* (_i, ctx) {
    await toolResult(invokeTool(m.services, 'tell', {}, { session: ctx.session, signal: ctx.signal, ...(ctx.appender !== undefined ? { appender: ctx.appender } : {}) }));
    yield { type: 'result', value: 1 };
  });
  const other = createSession();
  const elsewhere = tool('elsewhere', async function* (_i, ctx) {
    await ctx.appender!.append(other.id, [{ role: 'assistant', content: [{ type: 'text', text: 'over there' }] }]);
    yield { type: 'result', value: 1 };
  });
  const m: M = await machine(t, (prompt, messages) => answered(messages) ? says('done') : calls(prompt), [tell, viaBody, elsewhere]);
  await m.services.sessions.set(other.id, other);
  const results = await many(m, m.session, [acting('tell'), acting('via_body'), acting('elsewhere')]);
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  const said = (s: Session | null) => (s?.messages ?? []).map(msg => msg.content.map(c => c.type === 'text' ? c.text : '').join(''));
  assert.deepEqual(said(await m.services.sessions.get(m.session.id)), ['noted', 'noted']);
  assert.deepEqual(said(await m.services.sessions.get(other.id)), ['over there'], 'any session it names');
});

test('a turn may ask the calling conversation something: a user message is a robo-submit, not a report', { timeout: 15000 }, async t => {
  const results: unknown[] = [];
  const ask = tool('ask', async function* (_i, ctx) {
    // No session named: a sub-turn's appender defaults to the conversation it was called from.
    results.push(await ctx.appender!.append(undefined, [{ role: 'user', content: [{ type: 'text', text: 'what time is it?' }] }]));
    yield { type: 'result', value: 1 };
  });
  const m: M = await machine(t, (prompt, messages) => prompt === 'what time is it?' ? says('noon') : answered(messages) ? says('done') : calls(prompt), [ask]);
  const r = await invoke(m, m.session, acting('ask')) as SubTurnResult;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((results[0] as { traceId?: string }).traceId !== undefined, true, 'submitted as a turn');
  // The robo-submit is the conversation's own turn, beside the caller: wait for it to be answered there.
  for (let i = 0; i < 200; i++) {
    const s = (await m.services.sessions.get(m.session.id))!;
    if (s.messages.some(msg => msg.role === 'assistant')) break;
    await new Promise(res => setTimeout(res, 10));
  }
  const stored = (await m.services.sessions.get(m.session.id))!.messages;
  assert.deepEqual(stored.map(msg => msg.role), ['user', 'assistant']);
  assert.deepEqual(stored[0]!.metadata?.['roboSubmit'], { from: 'a sub-turn run from this conversation' });
});

test('with nobody to ask, a turn\'s gate takes the fallback, and says so', { timeout: 15000 }, async t => {
  const decisions: Array<{ allowed: boolean; source: string }> = [];
  const gated = tool('gated', async function* (_i, ctx) {
    decisions.push(await ctx.gate({ gate: 'act', subject: 'thing', label: 'Do the thing?', fallback: false }));
    yield { type: 'result', value: 1 };
  });
  const m = await machine(t, (_p, messages) => answered(messages) ? says('done') : calls('gated'), [gated]);
  const r = await invoke(m, m.session, acting('a')) as SubTurnResult;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(decisions, [{ allowed: false, source: 'fallback' }]);
});

test('gate answers are the session\'s: one given to a turn holds for the caller and for later turns', { timeout: 15000 }, async t => {
  const decisions: Array<{ allowed: boolean; source: string }> = [];
  const asked: string[] = [];
  const gated = tool('gated', async function* (_i, ctx) {
    decisions.push(await ctx.gate({ gate: 'act', subject: 'thing', label: 'Do the thing?', fallback: false }));
    yield { type: 'result', value: 1 };
  });
  const m = await machine(t, (_p, messages) => answered(messages) ? says('done') : calls('gated'), [gated]);
  const forTheSession = (async (field: FormField) => {
    asked.push(field.label);
    const options = (field.options ?? []) as { value: string }[];
    return options.find(o => o.value.includes('session') && o.value.includes('allow'))!.value;
  }) as PromptFn;

  await invoke(m, m.session, acting('a'), { prompt: forTheSession });
  assert.deepEqual(asked, ['Do the thing?'], 'the question reached the person');
  await invoke(m, m.session, acting('b'));
  await toolResult(invokeTool(m.services, 'gated', {}, { session: m.session, signal: new AbortController().signal }));
  assert.deepEqual(decisions.map(d => d.allowed), [true, true, true]);
  assert.equal(decisions[1]!.source, 'session');

  const other = createSession();
  await toolResult(invokeTool(m.services, 'gated', {}, { session: other, signal: new AbortController().signal }));
  assert.equal(decisions[3]!.allowed, false, 'and it is that session\'s answer, nobody else\'s');
});

// The whole ledger, through a real parent turn: a completion in a sub-turn lands in a transcript that is
// thrown away, and its roll-up names a head the parent does not have, so without the charge it is lost.
test('what the turns spend reaches the calling turn\'s ledger, once, attributed to the tool call', { timeout: 20000 }, async t => {
  const m = await machine(t, (prompt, messages) => {
    if (prompt === 'start') return answered(messages) ? says('all done') : calls('single_turn', { turns: [acting('a'), { prompt: 'b' }] });
    return says('x');
  });
  const view = await m.services.run.open({
    sessionId: m.session.id, signal: new AbortController().signal, provider: 'fake',
    principal: { id: 'tester', type: 'user' }, content: [{ type: 'text', text: 'start' }],
  });
  for await (const ev of view.events) if (ev.type === 'idle') break;
  const session = (await m.services.sessions.get(m.session.id))!;
  const entries = usageEntries(session.messages);
  const inTool  = entries.filter(e => e.site?.kind === 'tool' && e.site.tool === 'single_turn');
  assert.equal(inTool.length, 2, JSON.stringify(entries));
  assert.equal(entries.length, 4, 'the parent\'s own two rounds, and one call per turn');
});

test('an attachment is shown with an id, and that id passes it to a turn with tools and to one without', { timeout: 20000 }, async t => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');
  let id = '';
  const m = await machine(t, (prompt, messages) => {
    const shown = messages.flatMap(x => x.content.flatMap(c => (c.type === 'text' ? [c.text] : []))).join('\n');
    const note = /\[Attachment "shot\.png", id ([^\]]+)\]/.exec(shown)?.[1];
    if (prompt === 'start') {
      if (answered(messages)) return says('done');
      id = note ?? '';
      return calls('single_turn', { prompt: 'look', tools: true, attach: [id] });
    }
    return says('seen');
  });
  const view = await m.services.run.open({
    sessionId: m.session.id, signal: new AbortController().signal, provider: 'fake', principal: { id: 'tester', type: 'user' },
    content: [{ type: 'image', data: PNG, mimeType: 'image/png', name: 'shot.png' }, { type: 'text', text: 'start' }],
  });
  for await (const ev of view.events) if (ev.type === 'idle') break;
  assert.match(id, /#0$/, 'the model was shown an id it could use');
  const turnWire = m.seen.find(messages => promptOf(messages) === 'look');
  assert.ok(turnWire?.some(x => x.content.some(c => c.type === 'image' && c.data === PNG)), 'the turn was sent the bytes');
  const stored = (await m.services.sessions.get(m.session.id))!;
  assert.doesNotMatch(JSON.stringify(stored), /\[Attachment/, 'the note is on the wire only');

  const direct = await invoke(m, stored, { prompt: 'look again', attach: [id] });
  assert.ok(direct);
  assert.ok(m.seen.at(-1)?.some(x => x.content.some(c => c.type === 'image' && c.data === PNG)), 'without tools, it sent the same bytes');
});
