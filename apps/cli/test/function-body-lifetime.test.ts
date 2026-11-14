import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { buildAsyncFn, runFunction } from '@matatbread/matbot-function-tools';
import { makeToolBox } from '@matatbread/matbot-core';
import type { MatbotMachine, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

// Issue #114: a body's tool calls run under the calling turn's signal, and run to completion like any
// promise whether or not the body awaited them. Stopping them when the body settled was tried and removed:
// model-written fire-and-forget code failed at random. A body stops a call it no longer needs with a
// signal of its own; only an ABANDONED body (its caller stopped reading) has its later calls refused.

const stripper = { strip: (s: string) => stripTypeScriptTypes(s) };
const runner = createVmFunctionRunner(200);
const lambda = (src: string) => buildAsyncFn({ TypeScriptStripper: stripper, FunctionRunner: runner }, src, ['args']);

function machineWith(tools: Tool[]): MatbotMachine {
  const reg = new Map(tools.map(t => [t.name, t]));
  return { tools: { list: () => [...reg.values()], resolve: (n: string) => reg.get(n) ?? null } } as unknown as MatbotMachine;
}

const ctxFor = (signal: AbortSignal): ToolContext => ({
  callId: 'c1', session: { id: 's1' }, signal,
  prompt: () => Promise.reject(new Error('non-interactive')),
}) as unknown as ToolContext;

async function last(events: AsyncIterable<ToolEvent>): Promise<ToolEvent | undefined> {
  let final: ToolEvent | undefined;
  for await (const ev of events) final = ev;
  return final;
}

// A call that runs until its signal aborts, as a sub-turn does, and records that it was stopped.
function waiter(): Tool & { started: () => number; stopped: Promise<void> } {
  let started = 0;
  let stop!: () => void;
  const stopped = new Promise<void>(r => { stop = r; });
  return {
    name: 'wait', description: '', inputSchema: { type: 'object' },
    executor: {
      async *execute(_input, ctx) {
        started++;
        await new Promise<void>(r => { if (ctx.signal.aborted) r(); else ctx.signal.addEventListener('abort', () => r(), { once: true }); });
        stop();
        yield { type: 'error', message: 'stopped' };
      },
    },
    started: () => started,
    stopped,
  };
}
const quick: Tool = {
  name: 'quick', description: '', inputSchema: { type: 'object' },
  executor: { async *execute() { await new Promise(r => setTimeout(r, 5)); yield { type: 'result', value: 'quick' }; } },
};
const failing: Tool = {
  name: 'fail', description: '', inputSchema: { type: 'object' },
  executor: { async *execute() { await new Promise(r => setTimeout(r, 5)); yield { type: 'error', message: 'failed' }; } },
};

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms))]);

// A call that finishes after `ms`, unless its signal aborts first.
function sleeper(ms: number): Tool & { finished: () => number; aborted: () => number } {
  let finished = 0;
  let aborted = 0;
  return {
    name: 'sleep', description: '', inputSchema: { type: 'object' },
    executor: {
      async *execute(_input, ctx) {
        const ok = await new Promise<boolean>(r => {
          const t = setTimeout(() => r(true), ms);
          ctx.signal.addEventListener('abort', () => { clearTimeout(t); r(false); }, { once: true });
        });
        if (ok) { finished++; yield { type: 'result', value: 'slept' }; }
        else { aborted++; yield { type: 'error', message: 'stopped' }; }
      },
    },
    finished: () => finished,
    aborted:  () => aborted,
  };
}

test('calls a body left running finish after it returns, and nothing is logged', async (t) => {
  const warn = t.mock.method(console, 'warn', () => { /* captured */ });
  const sleep = sleeper(20);
  const turn = new AbortController();
  // The shape that failed at random: work started, not awaited, the body returning at once.
  const fn = await lambda("(args: {}): Promise<string> { void Promise.all([1, 2, 3].map(() => tool.sleep({}))); return 'started'; }");
  assert.deepEqual(await last(runFunction(machineWith([sleep]), ctxFor(turn.signal), fn, [{}], { tool: 'fanout', source: 'x' })),
                   { type: 'result', value: 'started' });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sleep.finished(), 3, 'every call ran to completion');
  assert.equal(sleep.aborted(), 0);
  assert.equal(warn.mock.callCount(), 0);
});

test('a Promise.race loser runs on unless the body gives it a signal', async () => {
  const sleep = sleeper(20);
  const plain = await lambda('(args: {}): Promise<unknown> { return Promise.race([tool.sleep({}), tool.quick({})]); }');
  assert.deepEqual(await last(runFunction(machineWith([sleep, quick]), ctxFor(new AbortController().signal), plain, [{}])),
                   { type: 'result', value: 'quick' });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sleep.finished(), 1, 'the loser finished');

  const stopped = sleeper(20);
  const withSignal = await lambda(`(args: {}): Promise<unknown> {
    const ac = new AbortController();
    const won = await Promise.race([toolInContext({ signal: ac.signal }).sleep({}), tool.quick({})]);
    ac.abort();
    return won;
  }`);
  assert.deepEqual(await last(runFunction(machineWith([stopped, quick]), ctxFor(new AbortController().signal), withSignal, [{}])),
                   { type: 'result', value: 'quick' });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(stopped.aborted(), 1, 'the body stopped its own loser');
  assert.equal(stopped.finished(), 0);
});

test("the turn's abort still stops a call the body left running", async () => {
  const wait = waiter();
  const turn = new AbortController();
  const fn = await lambda("(args: {}): Promise<string> { void tool.wait({}); return 'early'; }");
  assert.deepEqual(await last(runFunction(machineWith([wait]), ctxFor(turn.signal), fn, [{}])),
                   { type: 'result', value: 'early' });
  assert.equal(wait.started(), 1);
  turn.abort();
  await within(wait.stopped, 1000, 'the call saw the turn abort');
});

test('a failed call left alone is handled, and one awaited still rejects', async (t) => {
  const escaped: unknown[] = [];
  const onUnhandled = (e: unknown): void => { escaped.push(e); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });

  const box = makeToolBox(machineWith([failing]), { session: { id: 's1' } as never, signal: new AbortController().signal });
  const proxy = box.tool as unknown as Record<string, (p: object) => Promise<unknown>>;
  void proxy['fail']!({});
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(escaped, []);
  await assert.rejects(proxy['fail']!({}), /failed/, 'a caller that awaits still sees the rejection');
});

test('a call a timer makes after the body has settled runs: it was scheduled, not abandoned', async () => {
  // It was refused, which stopped the tool call and not the timer — bounding nothing, and failing one use of
  // an ordinary setTimeout at run time, after the body had reported success.
  const fn = await lambda("(args: {}): Promise<string> { setTimeout(() => { void tool.quick({}); }, 10); return 'done'; }");
  let ran = 0;
  const counted: Tool = { ...quick, executor: { async *execute() { ran++; yield { type: 'result', value: 'quick' }; } } };
  assert.deepEqual(await last(runFunction(machineWith([counted]), ctxFor(new AbortController().signal), fn, [{}])),
                   { type: 'result', value: 'done' });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(ran, 1, 'the late call ran');
});

test('a body whose caller stopped reading before it settled starts nothing more', async () => {
  let ran = 0;
  const counted: Tool = { ...quick, executor: { async *execute() { ran++; yield { type: 'result', value: 'quick' }; } } };
  const fn = await lambda("(args: {}): Promise<string> { context.progress(10); await new Promise(r => setTimeout(r, 20)); await tool.quick({}).catch(() => {}); return 'late'; }");
  const events = runFunction(machineWith([counted]), ctxFor(new AbortController().signal), fn, [{}])[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, 'progress');
  await events.return?.(undefined);   // the caller abandons the call while the body is still waiting
  await new Promise(r => setTimeout(r, 60));
  assert.equal(ran, 0, 'refused: the body was abandoned, not settled');
});
