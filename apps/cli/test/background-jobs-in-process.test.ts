import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, runAs } from '@matatbread/matbot-core';
import type {
  AppendMessage, CompletionEvent, MatbotMachine, Message, ProviderAdapter, ProviderConfig, Session,
  SessionAppender, Store, Tool, ToolContext, ToolRegistry,
} from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { makeSessionTools } from '@matatbread/matbot-sessions';
import { inProcessRunner, createBackgroundJobsPlugin } from '../../../plugins/background-jobs/src/index.ts';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// `matbot-background-jobs` runs a job's turn in this process, on an ephemeral run: its own transcript is
// stored nowhere, and it reports by appending to the conversation it was made from — through the run's
// appender, which labels the message with the job. These pin that path end to end, with a scripted model.

const PRINCIPAL = { id: 'tester', type: 'user' as const };

// Reports once, then finishes; records what it was shown.
function reporter(seen: Message[][]): ProviderAdapter {
  let call = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      const n = call++;
      seen.push(messages);
      return (async function* () {
        if (n === 0) yield { type: 'tool-call', id: 'c0', name: 'session_action', input: { action: 'append', text: 'Balance is 51M.' } };
        else         yield { type: 'text-delta', delta: 'Reported.' };
        yield { type: 'done' };
      })();
    },
  };
}

function machineWith(adapter: ProviderAdapter, extra: Tool[] = []): { machine: MatbotMachine; sessions: Store<Session>; appended: Array<{ sessionId: string | undefined; messages: readonly AppendMessage[] }> } {
  const sessions = new MemoryStore<Session>();
  const appended: Array<{ sessionId: string | undefined; messages: readonly AppendMessage[] }> = [];
  const appender: SessionAppender = { append: async (sessionId, messages) => {
    appended.push({ sessionId, messages });
    return { sessionId: sessionId ?? '?', messageIds: messages.map(() => 'm') };
  } };
  const [sessionTool] = makeSessionTools(sessions, { appender: () => appender }).filter(t => t.name === 'session_action');
  const all = [sessionTool!, ...extra];
  const tools = {
    register: () => {}, unregister: () => {},
    resolve:  (name: string) => all.find(t => t.name === name) ?? null,
    list:     () => all,
    has:      (name: string) => all.some(t => t.name === name),
  } as unknown as ToolRegistry;
  const config: ProviderConfig = { name: 'p', module: 'fake', model: 'fake' };
  const machine = {
    sessions,
    SessionAppender: appender,
    providers: new Map([['p', config]]),
    ephemeral(opts?: { appender?: SessionAppender }) {
      const store = new MemoryStore<Session>();
      return {
        sessions: store,
        run: createSessionRunner({
          store, tools,
          resolveProvider: async () => ({ adapter, config }),
          loadPlugin:      async () => { throw new Error('unused'); },
          unloadPlugin:    async () => false,
          ...(opts?.appender !== undefined ? { appender: opts.appender } : {}),
        }),
      };
    },
  } as unknown as MatbotMachine;
  return { machine, sessions, appended };
}

test('an in-process job reports to its conversation, labelled with the job, and leaves no session behind', { timeout: 15000 }, async () => {
  const seen: Message[][] = [];
  const { machine, sessions, appended } = machineWith(reporter(seen));
  const chat = createSession({ title: 'Money' });
  await sessions.set(chat.id, chat);
  const before = (await sessions.query({})).items.length;

  const runner = inProcessRunner(machine)!;
  const outcome = await runAs(PRINCIPAL, () => runner.run(
    { id: 'job-1', name: 'Balance', prompt: 'Check the balance and tell the user.', session: chat.id, provider: 'p', principal: PRINCIPAL },
    new AbortController().signal,
  ));

  assert.deepEqual(outcome, { appended: 1, reply: 'Reported.' });
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.sessionId, chat.id, 'an unnamed append goes to the conversation the job was made from');
  assert.deepEqual(appended[0]!.messages[0]!.metadata, { job: { id: 'job-1', name: 'Balance' } });
  assert.equal((await sessions.query({})).items.length, before, 'the job\'s own session was never stored');

  // The job is told what it is in its own first message — never through the machine-wide system context.
  const first = seen[0]!.find(m => m.role === 'user')!;
  const text = first.content.flatMap(c => (c.type === 'text' ? [c.text] : [])).join('\n');
  assert.match(text, /You are running as the background job "Balance"/);
  assert.match(text, /Check the balance and tell the user\./);
});

test('without an ephemeral runner no job is accepted, rather than one that will never run', async () => {
  const tools = new Map<string, Tool>();
  const services = {
    isSubAgent:  () => false,
    createStore: () => new MemoryStore(),
    tools:       { register: (t: Tool) => { tools.set(t.name, t); } },
  } as unknown as MatbotMachine;

  const plugin = createBackgroundJobsPlugin({ description: 'test', runner: inProcessRunner });
  const warn = console.warn;
  console.warn = () => {};
  try { await plugin.setup!(services); } finally { console.warn = warn; }
  try {
    for (const t of plugin.tools ?? []) tools.set(t.name, t as Tool);
    const events: Array<{ type: string; message?: string }> = [];
    await runAs(PRINCIPAL, async () => {
      const ctx = { session: { id: 's', messages: [] }, signal: new AbortController().signal, provider: 'p' } as unknown as ToolContext;
      for await (const ev of tools.get('background_job')!.executor.execute({ prompt: 'p', at: '2h' }, ctx)) events.push(ev as never);
    });
    assert.match(events.find(e => e.type === 'error')?.message ?? '', /cannot run in this matbot/);
  } finally {
    await plugin.teardown?.();
  }
});

test('a stored job waits out the first minute after setup, even if it is long past due', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const store = new MemoryStore<{ id: string; version: string; prompt: string; createdAt: string; nextRun: string; active: boolean }>();
  await store.set('due', { id: 'due', version: 'v', prompt: 'p', createdAt: past, nextRun: past, active: true });
  const ran: string[] = [];
  const plugin = createBackgroundJobsPlugin({ description: 'test', runner: () => ({ run: async job => { ran.push(job.id); return { appended: 0, reply: '' }; } }) });
  const services = {
    isSubAgent:  () => false,
    createStore: (ns: string) => (ns === 'jobs' ? store : new MemoryStore()),
    tools:       { register: () => {} },
  } as unknown as MatbotMachine;

  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  await plugin.setup!(services);
  try {
    await settle();
    t.mock.timers.tick(59_000);
    await settle();
    assert.deepEqual(ran, [], 'nothing fires while plugins may still be loading');
    t.mock.timers.tick(1_000);
    await settle();
    assert.deepEqual(ran, ['due'], 'and the past-due job runs once the grace is over');
  } finally {
    await plugin.teardown?.();
  }
});

test('cancelling a job stops its turn, not just the scheduler\'s view of it', { timeout: 15000 }, async () => {
  let toolStarted!: () => void;
  const started = new Promise<void>(r => { toolStarted = r; });
  let toolSawAbort = false;
  const slow: Tool = {
    name: 'slow', description: 'waits', inputSchema: { type: 'object', properties: {} },
    executor: { async *execute(_input: unknown, ctx: ToolContext) {
      toolStarted();
      await new Promise<void>(r => ctx.signal.addEventListener('abort', () => { toolSawAbort = true; r(); }, { once: true }));
      yield { type: 'result', value: 'interrupted' };
    } },
  };
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      calls++;
      return (async function* () {
        yield { type: 'tool-call', id: `c${calls}`, name: 'slow', input: {} };
        yield { type: 'done' };
      })();
    },
  };
  const { machine } = machineWith(adapter, [slow]);
  const ac = new AbortController();
  const running = runAs(PRINCIPAL, () => inProcessRunner(machine)!.run({ id: 'job-2', prompt: 'p', provider: 'p', principal: PRINCIPAL }, ac.signal));

  await started;
  ac.abort();
  const outcome = await running;
  assert.ok(toolSawAbort, 'the running tool was told to stop');
  assert.equal(calls, 1, 'and no further round started');
  assert.equal(outcome?.appended, 0);
});
