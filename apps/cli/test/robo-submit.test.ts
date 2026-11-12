import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, createSessionAppender, createSessionRunner, installPrincipalCarrier, installUsageCarrier, runAs,
  isRequest, isRoboSubmit, ROBO_SUBMIT, trailingRoboSubmits, UNATTENDED_ROBO_SUBMITS, withSenderShown,
} from '@matatbread/matbot-core';
import type {
  CompletionEvent, Message, Notifier, PermissionGate, PipelineEvent, PromptFn, ProviderAdapter, ProviderConfig,
  ProviderRegistry, Session, SessionRunner, Store, SubmitOpenOpts, Tool, ToolContext,
} from '@matatbread/matbot-core';
import { makeSessionTools } from '@matatbread/matbot-sessions';
import { createAlsPrincipalCarrier, createAlsUsageCarrier } from '@matatbread/matbot-host-node';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// A robo-submit: a user message handed to a SessionAppender is answered. It was written and left — a user
// message nobody answered, which the next thing a person typed was folded into (providers merge adjacent
// user messages) and which a redo re-ran in place of theirs. Now it is submitted to the session as a turn,
// beside anything running there, marked so triggers judge it as a request while a followup resubmit, which
// is also wholly robo-authored, still is not one.

const principal = { id: 'tester', type: 'user' as const };
const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
const notifier = { notify: () => {}, consume: async function* () {} } as unknown as Notifier;

function casStore(...seed: Session[]): { store: Store<Session>; docs: Map<string, Session> } {
  const docs = new Map(seed.map(s => [s.id, s]));
  const store = {
    get: async (id: string) => docs.get(id) ?? null,
    set: async (id: string, v: Session) => { docs.set(id, v); },
    cas: async (id: string, expected: string, next: Session) => {
      const cur = docs.get(id);
      if (!cur || cur.version !== expected) return { ok: false as const, doc: cur ?? null };
      docs.set(id, next);
      return { ok: true as const, doc: next };
    },
    delete: async (id: string) => docs.delete(id),
    query: async () => ({ items: [...docs.values()] }),
  } as unknown as Store<Session>;
  return { store, docs };
}

const user = (id: string, text: string, opts: { robo?: boolean; submit?: boolean } = {}): Message => ({
  id, role: 'user', traceId: id, createdAt: new Date(0).toISOString(),
  content: [{ type: 'text', text, ...(opts.robo || opts.submit ? { origin: 'robo' as const } : {}) }],
  ...(opts.submit ? { metadata: { [ROBO_SUBMIT]: true } } : {}),
}) as Message;
const reply = (id: string): Message =>
  ({ id, role: 'assistant', traceId: id, createdAt: new Date(0).toISOString(), content: [{ type: 'text', text: id }], providerName: 'fake' }) as Message;

const providers = (...names: string[]) => () => new Map(names.map(n => [n, { name: n }])) as unknown as ProviderRegistry;

// A runner that records what it is asked to run.
function recordingRun(): { run: SessionRunner; opened: SubmitOpenOpts[] } {
  const opened: SubmitOpenOpts[] = [];
  const run = {
    open: async (opts: SubmitOpenOpts) => { opened.push(opts); return { queued: 0, traceId: opts.traceId!, events: (async function* () {})() }; },
    status: () => ({ busy: false, running: false, queued: 0, parallel: 0, prompting: false }),
    write: () => { throw new Error('a robo-submit is not a write'); },
  } as unknown as SessionRunner;
  return { run, opened };
}

test('a person\'s message and a robo-submit are requests; a followup resubmit is not', () => {
  assert.equal(isRequest(user('a', 'hi')), true);
  assert.equal(isRequest(user('b', 'more', { robo: true })), false, 'continues the turn before it');
  assert.equal(isRequest(user('c', 'asked', { submit: true })), true);
  assert.equal(isRoboSubmit(user('c', 'asked', { submit: true })), true);
  assert.equal(isRequest(reply('d')), false);
});

test('an appended user message is submitted as a turn, in parallel, as robo, on the session\'s own model', async () => {
  const session = { ...createSession(), messages: [user('u', 'hello'), { ...reply('a'), providerName: 'claude' } as Message] };
  const { store, docs } = casStore(session);
  const { run, opened } = recordingRun();
  let promptedFor: [string, string] | undefined;
  const ask = (() => Promise.resolve('')) as PromptFn;
  const appender = createSessionAppender({
    sessions: () => store, run: () => run, notifier: () => notifier, isSubAgent: () => false,
    providers: providers('fake', 'claude'),
    prompter:  () => ({ promptFor: (sid, tid) => { promptedFor = [sid, tid]; return ask; } }),
  });

  const result = await runAs(principal, () => appender.append(session.id, [
    { role: 'user', content: [{ type: 'text', text: 'The email from virginmedia.com says there is a planned outage. What mitigation?' }], metadata: { job: { id: 'j1' } }, from: 'background job "mail"' },
  ]));

  assert.equal(opened.length, 1);
  const o = opened[0]!;
  assert.equal(o.mode, 'parallel', 'never stops a turn a person is having');
  assert.equal(o.provider, 'claude', 'the model the conversation last used');
  assert.deepEqual(o.principal, principal);
  assert.deepEqual(o.content, [{ type: 'text', text: 'The email from virginmedia.com says there is a planned outage. What mitigation?', origin: 'robo' }]);
  assert.deepEqual(o.metadata, { job: { id: 'j1' }, [ROBO_SUBMIT]: { from: 'background job "mail"' } });
  assert.equal(o.prompt, ask, 'asks through the frontend that can reach the session');
  assert.deepEqual(promptedFor, [session.id, o.traceId]);
  assert.equal(result.traceId, o.traceId);
  assert.deepEqual(result.messageIds, []);
  assert.equal(docs.get(session.id)!.messages.length, 2, 'nothing written by the append itself: the turn persists it');
});

test('a user message goes alone, and needs a principal', async () => {
  const session = createSession();
  const { store } = casStore(session);
  const { run } = recordingRun();
  const appender = createSessionAppender({ sessions: () => store, run: () => run, notifier: () => notifier, isSubAgent: () => false, providers: providers('fake') });
  await assert.rejects(
    runAs(principal, () => appender.append(session.id, [
      { role: 'assistant', content: [{ type: 'text', text: 'found it' }] },
      { role: 'user', content: [{ type: 'text', text: 'what now?' }] },
    ])),
    /goes alone/,
  );
});

test('with no model the session used, the first configured answers', async () => {
  const session = createSession();
  const { store } = casStore(session);
  const { run, opened } = recordingRun();
  const appender = createSessionAppender({ sessions: () => store, run: () => run, notifier: () => notifier, isSubAgent: () => false, providers: providers('first', 'second') });
  await runAs(principal, () => appender.append(session.id, [{ role: 'user', content: [{ type: 'text', text: 'q' }] }]));
  assert.equal(opened[0]!.provider, 'first');
});

test('robo-submits in a row are counted back to the last message a person sent, past followup resubmits', () => {
  const s = (...messages: Message[]): Session => ({ ...createSession(), messages });
  assert.equal(trailingRoboSubmits(s(user('h', 'hi'), reply('a'))), 0);
  assert.equal(trailingRoboSubmits(s(user('h', 'hi'), reply('a'), user('r1', 'x', { submit: true }), reply('b'))), 1);
  assert.equal(trailingRoboSubmits(s(
    user('r0', 'x', { submit: true }), reply('a'),
    user('h', 'hi'), reply('b'),
    user('r1', 'x', { submit: true }), reply('c'),
    user('f', 'resubmit', { robo: true }), reply('d'),
    user('r2', 'x', { submit: true }), reply('e'),
  )), 2, 'the person\'s message ends the run; a followup neither counts nor ends it');
});

// A real runner, its turns answered at once, and a gate that records what it was asked.
function runnerWith(session: Session, allow: boolean) {
  const { store, docs } = casStore(session);
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      return (async function* () { yield { type: 'text-delta', delta: 'answered' }; yield { type: 'done' }; })();
    },
  };
  const asked: Array<{ gate: string; subject: string; prompt: boolean }> = [];
  const gate = {
    decide: async (req: { gate: string; subject: string }, ask: PromptFn | undefined) => {
      asked.push({ gate: req.gate, subject: req.subject, prompt: ask !== undefined });
      return { allowed: allow, source: 'user' };
    },
    snapshot: async () => ({ decide: () => ({ allowed: false, source: 'fallback' }) }),
  } as unknown as PermissionGate;
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config }),
    permissionGate:  () => gate,
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });
  const submit = async (text: string): Promise<PipelineEvent[]> => {
    const view = await runAs(principal, () => runner.open({
      sessionId: session.id, signal: new AbortController().signal, provider: 'fake', principal, mode: 'parallel',
      content: [{ type: 'text', text, origin: 'robo' }], metadata: { [ROBO_SUBMIT]: true },
      prompt: (() => Promise.resolve('')) as PromptFn,
    }));
    const events: PipelineEvent[] = [];
    for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; }
    return events;
  };
  return { docs, asked, submit };
}

test('a robo-submit is persisted marked as one, and answered', async () => {
  const session = createSession();
  const { docs, asked, submit } = runnerWith(session, true);
  await submit('what mitigation?');
  const messages = docs.get(session.id)!.messages;
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(isRoboSubmit(messages[0]!), true);
  assert.equal(isRequest(messages[0]!), true);
  assert.equal(asked.length, 0, 'the first few run unasked');
});

test(`past ${UNATTENDED_ROBO_SUBMITS} in a row a person is asked whether to continue, through the turn's prompt`, async () => {
  const runs = Array.from({ length: UNATTENDED_ROBO_SUBMITS }, (_, i) => [user(`r${i}`, 'x', { submit: true }), reply(`a${i}`)]).flat();
  const session = { ...createSession(), messages: [user('h', 'hi'), reply('a'), ...runs] };

  const allowed = runnerWith(structuredClone(session), true);
  await allowed.submit('again');
  assert.deepEqual(allowed.asked, [{ gate: 'tools.robo-submit', subject: session.id, prompt: true }]);
  assert.equal(allowed.docs.get(session.id)!.messages.length, session.messages.length + 2, 'continued');

  const refused = runnerWith(structuredClone(session), false);
  const events = await refused.submit('again');
  assert.ok(events.some(e => e.type === 'cancelled'), 'the submission is reported cancelled');
  assert.equal(refused.docs.get(session.id)!.messages.length, session.messages.length, 'and nothing of it is written');
});

test('session_action append with submit posts a request the conversation answers', async () => {
  const session = createSession();
  const { store } = casStore(session);
  const { run, opened } = recordingRun();
  const appender = createSessionAppender({ sessions: () => store, run: () => run, notifier: () => notifier, isSubAgent: () => false, providers: providers('fake') });
  const [tool] = makeSessionTools(store, { run: () => run, appender: () => appender });
  const ctx = { callId: 'c', signal: new AbortController().signal, session: { id: 'other', messages: [] } } as unknown as ToolContext;
  const result = await runAs(principal, async () => {
    for await (const ev of (tool as Tool).executor.execute({ action: 'append', sessionId: session.id, text: 'what now?', submit: true }, ctx)) {
      if (ev.type === 'result') return ev.value as { traceId?: string };
      if (ev.type === 'error') throw new Error(ev.message);
    }
    throw new Error('no result');
  });
  assert.equal(opened.length, 1);
  assert.equal(result.traceId, opened[0]!.traceId);
});

test('a robo-submit arriving during a person\'s turn runs beside it, and keeps its mark through the merge', { timeout: 15000 }, async () => {
  const session = createSession();
  const { store, docs } = casStore(session);
  let entered: () => void = () => {};
  const enteredP = new Promise<void>(r => { entered = r; });
  let release: () => void = () => {};
  const releaseP = new Promise<void>(r => { release = r; });
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      const held = messages.findLast(m => m.role === 'user')?.content.some(c => c.type === 'text' && c.text === 'person');
      return (async function* () {
        if (held) { entered(); await releaseP; }
        yield { type: 'text-delta', delta: held ? 'to the person' : 'to the job' };
        yield { type: 'done' };
      })();
    },
  };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config }),
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });
  const person = await runAs(principal, () => runner.open({
    sessionId: session.id, signal: new AbortController().signal, provider: 'fake', principal,
    content: [{ type: 'text', text: 'person' }],
  }));
  const idle = (async () => { for await (const ev of person.events) if (ev.type === 'idle') break; })();
  await enteredP;

  const appender = createSessionAppender({
    sessions: () => store, run: () => runner, notifier: () => notifier, isSubAgent: () => false, providers: providers('fake'),
  });
  await runAs(principal, () => appender.append(session.id, [{ role: 'user', content: [{ type: 'text', text: 'job asks' }] }]));
  // The job's turn is answered while the person's is still held.
  for (let i = 0; i < 100 && !docs.get(session.id)!.messages.some(isRoboSubmit); i++) await new Promise(r => setTimeout(r, 10));
  release();
  await idle;

  const messages = docs.get(session.id)!.messages;
  const asked = messages.find(isRoboSubmit);
  assert.ok(asked, 'the robo-submit was placed, still marked');
  const answer = messages[messages.indexOf(asked) + 1];
  assert.equal(answer?.role, 'assistant');
  assert.match(answer.content.map(c => c.type === 'text' ? c.text : '').join(''), /to the job/);
  assert.ok(messages.some(m => m.role === 'assistant' && m.content.some(c => c.type === 'text' && c.text === 'to the person')), 'and the person\'s turn finished too');
});

test('a model is told who sent a robo-submit, on the wire only', async () => {
  const asked = { ...user('r', 'what time is it?', { submit: true }), metadata: { [ROBO_SUBMIT]: { from: 'background job "clock"' } } };
  assert.deepEqual(withSenderShown(asked).content[0], { type: 'text', text: '[Sent by background job "clock", not by the person in this conversation.]' });
  assert.match((withSenderShown(user('o', 'x', { submit: true })).content[0] as { text: string }).text, /an automated process/, 'a mark from before `from` existed');
  const person = user('p', 'hi');
  assert.equal(withSenderShown(person), person, 'anything else is the same object');

  const session = { ...createSession(), messages: [asked] };
  const { store, docs } = casStore(session);
  const sent: Message[][] = [];
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      sent.push([...messages]);
      return (async function* () { yield { type: 'text-delta', delta: 'noon' }; yield { type: 'done' }; })();
    },
  };
  const runner = createSessionRunner({
    store, resolveProvider: async () => ({ adapter, config }),
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  });
  const view = await runAs(principal, () => runner.open({
    sessionId: session.id, signal: new AbortController().signal, provider: 'fake', principal, content: [{ type: 'text', text: 'and you?' }],
  }));
  for await (const ev of view.events) if (ev.type === 'idle') break;
  const wire = sent[0]!.find(m => m.id === 'r')!;
  assert.match((wire.content[0] as { text: string }).text, /^\[Sent by background job "clock"/);
  assert.equal(docs.get(session.id)!.messages[0]!.content.length, 1, 'never stored');
});
