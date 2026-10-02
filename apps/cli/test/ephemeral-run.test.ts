import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, runEphemeralTurn,
} from '@matatbread/matbot-core';
import type {
  Session, Store, ToolRegistry, ProviderAdapter, ProviderConfig, CompletionEvent, PipelineEvent, Principal,
  SessionAppender, EphemeralRun, Tool,
} from '@matatbread/matbot-core';
import { MemoryStore } from '@matatbread/matbot-core/storage-base';
import { makeSessionTools } from '@matatbread/matbot-sessions';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// An ephemeral run is a turn over a private in-memory store — a background job's, a demonstration's.
// Its tools still hold the machine's real stores, so the one thing that has to be told where it is is an
// append: the turn's own session exists nowhere the machine's appender can reach, and is never where a
// report should go. The runner hands its appender to tools as `ctx.appender` for exactly that.

const principal: Principal = { id: 'tester', type: 'user' };

function recording(defaultSessionId?: string): { appender: SessionAppender; calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    appender: {
      ...(defaultSessionId !== undefined ? { defaultSessionId } : {}),
      append: async (sessionId, messages) => {
        calls.push(sessionId);
        return { sessionId: sessionId ?? '?', messageIds: messages.map(() => 'm') };
      },
    },
  };
}

// Calls `session_action append` with no sessionId, then finishes; captures what the tool answered.
function appendingProvider(results: string[]): ProviderAdapter {
  let call = 0;
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      const n = call++;
      const last = messages.at(-1);
      if (n === 1 && last?.role === 'tool') {
        for (const c of last.content) if (c.type === 'tool-result') results.push(JSON.stringify(c.result));
      }
      return (async function* () {
        if (n === 0) yield { type: 'tool-call', id: 'c0', name: 'session_action', input: { action: 'append', text: 'Balance is over 50M.' } };
        else         yield { type: 'text-delta', delta: 'done' };
        yield { type: 'done' };
      })();
    },
  };
}

async function runEphemeral(machineAppender: SessionAppender, runAppender: SessionAppender | undefined): Promise<string[]> {
  // The machine's own store: what `session_action` captured at setup, and nothing this run writes to.
  const machineStore = new MemoryStore<Session>();
  const [tool] = makeSessionTools(machineStore, { appender: () => machineAppender }).filter(t => t.name === 'session_action');
  const tools = {
    register: () => {}, unregister: () => {},
    resolve:  (name: string) => (name === tool!.name ? tool! : null),
    list:     () => [tool!],
    has:      (name: string) => name === tool!.name,
  } as unknown as ToolRegistry;

  const store   = new MemoryStore<Session>();
  const session = createSession();
  await store.set(session.id, session);
  const results: string[] = [];
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const runner = createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: appendingProvider(results), config }),
    tools,
    loadPlugin:   async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
    ...(runAppender !== undefined ? { appender: runAppender } : {}),
  });
  const view = await runner.open({
    sessionId: session.id, signal: new AbortController().signal,
    content: [{ type: 'text', text: 'check the balance' }], provider: 'fake', principal,
  });
  for await (const ev of view.events as AsyncIterable<PipelineEvent>) if (ev.type === 'idle') break;
  assert.equal(await machineStore.get(session.id), null, 'the ephemeral session never reached the machine\'s store');
  return results;
}

test('an append from an ephemeral turn goes where the run reports, not to the machine or the turn\'s own session', { timeout: 15000 }, async () => {
  const machine = recording();
  const run     = recording('reports-here');
  const results = await runEphemeral(machine.appender, run.appender);
  assert.deepEqual(run.calls, ['reports-here'], JSON.stringify(results));
  assert.deepEqual(machine.calls, [], 'the machine\'s appender is not consulted');
});

test('an ephemeral run that reports nowhere refuses an unnamed append rather than posting into itself', { timeout: 15000 }, async () => {
  const machine = recording();
  const run     = recording();
  const results = await runEphemeral(machine.appender, run.appender);
  assert.deepEqual(run.calls, []);
  assert.match(results.join('\n'), /reports to no conversation/);
});

// `runEphemeralTurn` is the one turn a background job and a skill demonstration each ran for themselves:
// fresh session, open, wire the caller's signal to the run's abort, keep to its own turn's events, stop at
// the terminal, and recover the transcript when the terminal carries none.

// A tool that blocks until the turn is aborted, so a test can tell a stopped turn from a finished one.
function ephemeralWith(script: 'tool' | 'answer' | 'fail'): { demo: EphemeralRun; toolStarted: Promise<void>; toolAborted: Promise<void> } {
  let started!: () => void;
  let aborted!: () => void;
  const toolStarted = new Promise<void>(r => { started = r; });
  const toolAborted = new Promise<void>(r => { aborted = r; });
  const blocker: Tool = {
    name: 'block', description: 'blocks until aborted', inputSchema: { type: 'object' },
    executor: {
      execute(_input, ctx) {
        return (async function* () {
          started();
          await new Promise<void>(r => { if (ctx.signal.aborted) r(); else ctx.signal.addEventListener('abort', () => r(), { once: true }); });
          aborted();
          yield { type: 'result' as const, value: {} };
        })();
      },
    },
  };
  const tools = {
    register: () => {}, unregister: () => {},
    resolve: (n: string) => (n === 'block' ? blocker : null), list: () => [blocker], has: (n: string) => n === 'block',
  } as unknown as ToolRegistry;
  const adapter: ProviderAdapter = {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(): AsyncIterable<CompletionEvent> {
      return (async function* () {
        if (script === 'fail') throw new Error('provider down');
        if (script === 'tool') yield { type: 'tool-call', id: 'c0', name: 'block', input: {} };
        else yield { type: 'text-delta', delta: 'answered' };
        yield { type: 'done' };
      })();
    },
  };
  const store = new MemoryStore<Session>();
  const run = createSessionRunner({
    store, tools,
    resolveProvider: async () => ({ adapter, config: { name: 'fake', module: 'fake', model: 'fake' } as ProviderConfig }),
    loadPlugin: async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin: async () => false,
  });
  return { demo: { sessions: store, run }, toolStarted, toolAborted };
}

const turnOpts = (signal: AbortSignal) => ({ content: [{ type: 'text' as const, text: 'go' }], provider: 'fake', principal, signal });

test('runEphemeralTurn yields its own turn and returns the transcript', async () => {
  const { demo } = ephemeralWith('answer');
  const turn = runEphemeralTurn(demo, { ...turnOpts(new AbortController().signal), sessionId: 'named' });
  const types: string[] = [];
  let next = await turn.next();
  for (; !next.done; next = await turn.next()) types.push(next.value.type);
  assert.equal(types.at(-1), 'done', 'up to and including its terminal');
  assert.ok(!types.includes('idle'), 'only the turn\'s own events, not the session\'s');
  assert.equal(next.value?.id, 'named');
  assert.equal(next.value?.messages.at(-1)?.role, 'assistant');
});

test('runEphemeralTurn stops the turn when its signal aborts', { timeout: 10000 }, async () => {
  const { demo, toolStarted, toolAborted } = ephemeralWith('tool');
  const ac = new AbortController();
  const turn = runEphemeralTurn(demo, turnOpts(ac.signal));
  const draining = (async () => { let n = await turn.next(); while (!n.done) n = await turn.next(); return n.value; })();
  await toolStarted;
  ac.abort();
  await toolAborted;
  const final = await draining;
  assert.ok(final, 'the transcript of the stopped turn comes back');
});

test('runEphemeralTurn stops a turn its caller stopped reading', { timeout: 10000 }, async () => {
  const { demo, toolStarted, toolAborted } = ephemeralWith('tool');
  const turn = runEphemeralTurn(demo, turnOpts(new AbortController().signal));
  const reading = (async () => { for await (const ev of turn) if (ev.type === 'tool:start') return; })();
  await toolStarted;
  await reading;
  await toolAborted;
});

test('runEphemeralTurn recovers the transcript when the turn ends in an error', { timeout: 10000 }, async () => {
  const { demo } = ephemeralWith('fail');
  const turn = runEphemeralTurn(demo, turnOpts(new AbortController().signal));
  let next = await turn.next();
  const types: string[] = [];
  for (; !next.done; next = await turn.next()) types.push(next.value.type);
  assert.equal(types.at(-1), 'error');
  assert.equal(next.value?.messages[0]?.role, 'user', 'read back from the run\'s store');
});
