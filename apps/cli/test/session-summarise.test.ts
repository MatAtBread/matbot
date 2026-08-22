import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAs, installPrincipalCarrier, machineBusy } from '@matatbread/matbot-core';
import type { MatbotMachine, Message, Session, Store, Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { createAlsPrincipalCarrier } from '../src/principal-als.ts';
import { plugin as editSessionPlugin } from '../../../plugins/edit-session/src/index.ts';

// `session_edit`'s `summarise` replaces history with an LLM-written hand-off pair. Two properties carry
// the whole design, and neither is visible from the happy path alone:
//
//   1. The replaced messages are not destroyed — they move into a marker the model never sees. So a
//      SECOND summarise summarises the ORIGINAL text, not the first summary, and the loss does not
//      compound each time the session is compacted.
//   2. The edit happens only if the summary arrived intact. The LLM call runs before any mutation, so a
//      provider that returned prose instead of the two-part document leaves the session untouched and
//      says so — the alternative is replacing real history with something unparsed.

installPrincipalCarrier(createAlsPrincipalCarrier());

const PRINCIPAL = { id: 'tester', type: 'user' as const };

function msg(id: string, role: Message['role'], text: string): Message {
  return { id, role, content: [{ type: 'text', text }], createdAt: new Date(1_700_000_000_000).toISOString(), traceId: 't' };
}

function seed(): Session {
  return {
    id: 'target', version: 'v1', title: 'work', status: 'active',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    messages: [
      msg('m1', 'user',      'make the widget blue, and keep it under 4kB'),
      msg('m2', 'assistant', 'trying a CSS variable'),
      msg('m3', 'user',      'that broke dark mode'),
      msg('m4', 'assistant', 'reverted; using a data-theme override instead — that works'),
      msg('m5', 'user',      'what about the icon?'),
      msg('m6', 'assistant', 'not started'),
    ],
  } as unknown as Session;
}

const HANDOFF =
  '<<<GOAL>>>\nI want the widget blue, under 4kB, without breaking dark mode.\n' +
  '<<<STATE>>>\nDecided: data-theme override (a CSS variable broke dark mode). Open: the icon.';

/** The plugin, set up against a one-session store and a scripted summariser. */
async function harness(reply: string | string[]) {
  const docs = new Map<string, Session>([['target', seed()]]);
  const replies = Array.isArray(reply) ? [...reply] : [reply];
  const prompts: string[] = [];

  const store = {
    async get(id: string) { return docs.get(id) ?? null; },
    async set(id: string, v: Session) { docs.set(id, v); },
    async cas(id: string, expected: string, next: Session) {
      const cur = docs.get(id);
      if (!cur || cur.version !== expected) return { ok: false as const, doc: cur ?? null };
      docs.set(id, next);
      return { ok: true as const, doc: next };
    },
    async delete(id: string) { return docs.delete(id); },
    async query() { return { items: [...docs.values()] }; },
  } as unknown as Store<Session>;

  const tools = new Map<string, Tool>();
  const services = {
    sessions: store,
    tools:    { register: (t: Tool) => { tools.set(t.name, t); } },
    async singleTurn(req: { prompt: string }) {
      prompts.push(req.prompt);
      return { text: replies.length > 1 ? replies.shift()! : replies[0]! };
    },
  } as unknown as MatbotMachine;

  await editSessionPlugin.setup!(services);
  const tool = tools.get('session_edit')!;

  // A DIFFERENT session id than the one being edited: the tool defers an edit of its own running
  // session (the turn owns that document), and the inline path is what these assertions read.
  const ctx = {
    callId: 'c1', signal: new AbortController().signal, provider: 'test-provider',
    session: { id: 'some-other-session', messages: [] },
  } as unknown as ToolContext;

  const run = (input: unknown) => runAs(PRINCIPAL, async () => {
    const events: Array<{ type: string; value?: unknown; message?: string }> = [];
    for await (const ev of tool.executor.execute(input, ctx)) events.push(ev as never);
    return events;
  });

  return { run, docs, prompts };
}

function markerMessages(s: Session): Message[] {
  const marker = s.messages.find(m => m.role === 'marker');
  assert.ok(marker, 'the summarised history must be kept in a marker');
  const block = marker.content.find(c => c.type === 'marker');
  assert.ok(block && block.type === 'marker');
  const data = block.data as { relation: string; messages: Message[] };
  assert.equal(data.relation, 'summarised');
  return data.messages;
}

test('the summary replaces the history as a robo user/assistant pair, and the originals move into a marker', async () => {
  const { run, docs } = await harness(HANDOFF);

  const events = await run({ action: 'summarise', sessionId: 'target', msgIndex: 4 });
  const result = events.find(e => e.type === 'result')?.value as
    { sessionId: string; messagesSummarised: number; charsBefore: number; charsAfter: number };

  assert.equal(events.some(e => e.type === 'error'), false, JSON.stringify(events));
  assert.equal(result.messagesSummarised, 4);
  assert.ok(result.charsAfter < result.charsBefore, 'a summary that does not shrink the context is not a summary');

  const after = docs.get('target')!;
  // marker + the pair + the two retained messages.
  assert.deepEqual(after.messages.map(m => m.role), ['marker', 'user', 'assistant', 'user', 'assistant']);

  const [, goal, state] = after.messages;
  assert.match((goal!.content[0] as { text: string }).text, /under 4kB/);
  assert.match((state!.content[0] as { text: string }).text, /data-theme override/);
  // Authorship, not role: matbot wrote both halves, so a frontend presents them agent-side while the
  // model still reads an ordinary user turn and assistant reply.
  assert.equal((goal!.content[0] as { origin?: string }).origin, 'robo');
  assert.equal((state!.content[0] as { origin?: string }).origin, 'robo');

  assert.deepEqual(markerMessages(after).map(m => m.id), ['m1', 'm2', 'm3', 'm4']);
  // The summary stands where the history stood: `lastActivityAt` reads the last message's stamp, so a
  // now-stamped replacement would re-date a fully-summarised session to the top of a recency list.
  assert.equal(after.messages[1]!.createdAt, seed().messages[3]!.createdAt);
  assert.equal(after.updatedAt, seed().messages[5]!.createdAt);
});

test('a second summarise reads the ORIGINAL history out of the marker, never the first summary', async () => {
  const second = '<<<GOAL>>>\nBlue widget, under 4kB, dark mode intact.\n<<<STATE>>>\nStill only the icon left.';
  const { run, docs, prompts } = await harness([HANDOFF, second]);

  await run({ action: 'summarise', sessionId: 'target', msgIndex: 4 });
  await run({ action: 'summarise', sessionId: 'target', msgIndex: 4 });   // marker + the pair

  assert.equal(prompts.length, 2);
  // The transcript the second call saw contains the words of the messages the FIRST call replaced …
  assert.match(prompts[1]!, /trying a CSS variable/);
  assert.match(prompts[1]!, /that broke dark mode/);
  // … and the marker written by the second call still holds them, flat rather than nested one deep per
  // pass, so the original text stays exactly one hop from the session however often it is summarised.
  const ids = markerMessages(docs.get('target')!).map(m => m.id);
  assert.deepEqual(ids.slice(0, 4), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(docs.get('target')!.messages.filter(m => m.role === 'marker').length, 1);
});

test('a summary that is not the two-part document changes nothing and says why', async () => {
  const { run, docs } = await harness('Sure! Here is a summary of your conversation: you wanted a blue widget.');
  const before = structuredClone(docs.get('target'));

  const events = await run({ action: 'summarise', sessionId: 'target', msgIndex: 4 });

  const error = events.find(e => e.type === 'error')?.message ?? '';
  assert.match(error, /GOAL/);
  assert.match(error, /left untouched/);
  assert.deepEqual(docs.get('target'), before, 'a malformed summary must not replace real history');
});

test('summarising the running turn\'s own session is queued, not applied', async () => {
  const docs   = new Map<string, Session>([['target', seed()]]);
  const writes: string[] = [];
  const store = {
    async get(id: string) { return docs.get(id) ?? null; },
    async set(id: string, v: Session) { writes.push(id); docs.set(id, v); },
    async cas(id: string, expected: string, next: Session) {
      const cur = docs.get(id);
      if (!cur || cur.version !== expected) return { ok: false as const, doc: cur ?? null };
      writes.push(id); docs.set(id, next);
      return { ok: true as const, doc: next };
    },
    async delete() { return false; },
    async query() { return { items: [...docs.values()] }; },
  } as unknown as Store<Session>;

  const tools = new Map<string, Tool>();
  const services = {
    sessions: store,
    tools:    { register: (t: Tool) => { tools.set(t.name, t); } },
    singleTurn: async () => ({ text: HANDOFF }),
  } as unknown as MatbotMachine;
  await editSessionPlugin.setup!(services);

  const ctx = {
    callId: 'c1', signal: new AbortController().signal, provider: 'test-provider',
    session: seed(),                                   // the tool's own session IS the target
  } as unknown as ToolContext;

  const events: Array<{ type: string; value?: unknown; message?: string }> = [];
  // Held, because that is what makes the deferral observable: the pump holds the machine across its
  // whole queue, so the quiescent edge the edit is queued on cannot arrive until the turn has ended.
  // Without the hold the edge lands on the next microtask and the deferral is untestable.
  await machineBusy(async () => {
    await runAs(PRINCIPAL, async () => {
      for await (const ev of tools.get('session_edit')!.executor.execute(
        { action: 'summarize', sessionId: 'target', msgIndex: 4 }, ctx)) events.push(ev as never);
    });

    // Nothing written yet: the turn owns that document until it commits, and a write landing here would
    // be overwritten seconds later by the runner's own write-back — silently, since that is not a CAS.
    assert.deepEqual(writes, []);
  });

  const value = events.find(e => e.type === 'result')?.value as { deferred: boolean; message: string };
  assert.equal(value.deferred, true, JSON.stringify(events));
  assert.match(value.message, /queued/);
  // The American spelling reached the same action: being told "unknown action" for it teaches nothing.

  // …and it lands as the hold releases — the edge suspends on the flusher, so no extra wait is needed.
  assert.deepEqual(writes, ['target']);
  assert.deepEqual(docs.get('target')!.messages.map(m => m.role), ['marker', 'user', 'assistant', 'user', 'assistant']);
});

test('no msgIndex means the whole session — and in the running one, everything before this turn', async () => {
  // The failure this encodes: the first real summarise was called with msgIndex -1 on the session it was
  // running in, so the range swallowed the user's "compact this session" request AND the turn's own tool
  // rounds. Those were the freshest thing in the transcript, and the summary came back describing the
  // compaction instead of the conversation. Omitting the index now means "the whole session", which in
  // your own session ends where the turn asking for it began.
  const docs = new Map<string, Session>();
  const seen: string[] = [];
  const store = {
    async get(id: string) { return docs.get(id) ?? null; },
    async set(id: string, v: Session) { docs.set(id, v); },
    async cas(id: string, expected: string, next: Session) {
      const cur = docs.get(id);
      if (!cur || cur.version !== expected) return { ok: false as const, doc: cur ?? null };
      docs.set(id, next);
      return { ok: true as const, doc: next };
    },
    async delete() { return false; },
    async query() { return { items: [...docs.values()] }; },
  } as unknown as Store<Session>;

  const tools = new Map<string, Tool>();
  const services = {
    sessions: store,
    tools:    { register: (t: Tool) => { tools.set(t.name, t); } },
    async singleTurn(req: { prompt: string }) { seen.push(req.prompt); return { text: HANDOFF }; },
  } as unknown as MatbotMachine;
  await editSessionPlugin.setup!(services);
  const tool = tools.get('session_edit')!;

  // ── another session: the whole session really is all of it, including the last message ──
  docs.set('other', seed());
  const other = { callId: 'c', signal: new AbortController().signal, provider: 'p',
                  session: { id: 'not-this-one', messages: [] } } as unknown as ToolContext;
  const events: Array<{ type: string; value?: unknown; message?: string }> = [];
  await runAs(PRINCIPAL, async () => {
    for await (const ev of tool.executor.execute({ action: 'summarise', sessionId: 'other' }, other)) events.push(ev as never);
  });
  const value = events.find(e => e.type === 'result')?.value as { messagesSummarised: number };
  assert.equal(value.messagesSummarised, 6, 'all six, not five — [0, length) is a legal range');
  assert.deepEqual(docs.get('other')!.messages.map(m => m.role), ['marker', 'user', 'assistant']);

  // ── the running session: a turn in flight, mid-tool-round, asking to be summarised ──
  const running = seed();
  running.messages.push(
    msg('m7', 'user', 'summarise this session'),                       // THIS turn's request
    { ...msg('m8', 'assistant', ''), content: [{ type: 'tool-call', id: 't1', name: 'tool_search', input: {} }] },
    { ...msg('m9', 'tool', ''),      content: [{ type: 'tool-result', id: 't1', result: 'session_edit' }] },
  );
  docs.set('running', { ...running, id: 'running' });
  const ctx = { callId: 'c', signal: new AbortController().signal, provider: 'p',
                session: { ...running, id: 'running' } } as unknown as ToolContext;

  seen.length = 0;
  const ev2: Array<{ type: string; value?: unknown }> = [];
  await machineBusy(async () => {
    await runAs(PRINCIPAL, async () => {
      for await (const ev of tool.executor.execute({ action: 'summarise', sessionId: 'running' }, ctx)) ev2.push(ev as never);
    });
  });

  assert.equal((ev2.find(e => e.type === 'result')?.value as { deferred?: boolean }).deferred, true);
  // The request and the turn's tool rounds are NOT in what the summariser was shown …
  assert.doesNotMatch(seen[0]!, /summarise this session/);
  assert.doesNotMatch(seen[0]!, /tool_search/);
  // … and they are still in the session afterwards, following the summary of what came before them.
  const after = docs.get('running')!;
  assert.deepEqual(after.messages.map(m => m.role), ['marker', 'user', 'assistant', 'user', 'assistant', 'tool']);
  assert.equal((after.messages[3]!.content[0] as { text: string }).text, 'summarise this session');
  assert.deepEqual(markerMessages(after).map(m => m.id), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
});

test('the positional actions still demand an index, and say who may omit it', async () => {
  const { run } = await harness(HANDOFF);
  for (const action of ['cut', 'fork', 'split', 'compact']) {
    const events = await run({ action, sessionId: 'target' });
    assert.match(events.find(e => e.type === 'error')?.message ?? '', /requires "msgIndex"/, action);
    assert.match(events.find(e => e.type === 'error')?.message ?? '', /Only "summarise" may omit it/, action);
  }
});
