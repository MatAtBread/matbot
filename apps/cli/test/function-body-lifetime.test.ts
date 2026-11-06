import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { buildAsyncFn, runFunction } from '@matatbread/matbot-function-tools';
import { makeToolBox } from '@matatbread/matbot-core';
import type { MatbotMachine, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

// Issue #114: a body's tool calls were handed the calling TURN's signal, so a call the body started and
// did not finish waiting for ran on after the body settled — since `single_turn` gained `tools: true`, as
// a whole agent turn, for a result nothing would read. Each invocation now has a lifetime of its own.

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

test('a Promise.race loser is stopped when the body returns, while the turn runs on', async (t) => {
  const warn = t.mock.method(console, 'warn', () => { /* captured */ });
  const wait = waiter();
  const turn = new AbortController();
  const fn = await lambda('(args: {}): Promise<unknown> { return Promise.race([tool.wait({}), tool.quick({})]); }');
  assert.deepEqual(await last(runFunction(machineWith([wait, quick]), ctxFor(turn.signal), fn, [{}], { tool: 'racer', source: 'x' })),
                   { type: 'result', value: 'quick' });
  await within(wait.stopped, 1000, 'the loser saw its signal abort');
  assert.equal(turn.signal.aborted, false, 'the calling turn is untouched');
  assert.equal(warn.mock.callCount(), 1);
  const line = String(warn.mock.calls[0]?.arguments[0]);
  for (const part of ['racer', 'session s1', 'call c1', '1 tool call still running']) assert.ok(line.includes(part), `${part} in: ${line}`);
});

test('a Promise.all sibling is stopped when another call rejects', async (t) => {
  t.mock.method(console, 'warn', () => { /* captured */ });
  const wait = waiter();
  const fn = await lambda('(args: {}): Promise<unknown> { return Promise.all([tool.wait({}), tool.fail({})]); }');
  const ev = await last(runFunction(machineWith([wait, failing]), ctxFor(new AbortController().signal), fn, [{}]));
  assert.equal(ev?.type, 'error');
  await within(wait.stopped, 1000, 'the sibling saw its signal abort');
});

test('a call never awaited is stopped at return, and its rejection does not escape the body', async (t) => {
  const warn = t.mock.method(console, 'warn', () => { /* captured */ });
  const escaped: unknown[] = [];
  const onUnhandled = (e: unknown): void => { escaped.push(e); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });

  const wait = waiter();
  const fn = await lambda("(args: {}): Promise<string> { void tool.wait({}); return 'early'; }");
  assert.deepEqual(await last(runFunction(machineWith([wait]), ctxFor(new AbortController().signal), fn, [{}])),
                   { type: 'result', value: 'early' });
  await within(wait.stopped, 1000, 'the dropped call saw its signal abort');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(escaped, [], 'the stopped call rejected into nothing, not into the process');
  assert.equal(warn.mock.callCount(), 1);
});

test('a body stopped at the runner bound stops the calls it left running', async (t) => {
  t.mock.method(console, 'warn', () => { /* captured */ });
  const wait = waiter();
  const fn = await lambda('(args: {}): Promise<number> { void tool.wait({}); let d = 1; while (d > 0) { d = d; } return d; }');
  const ev = await last(runFunction(machineWith([wait]), ctxFor(new AbortController().signal), fn, [{}]));
  assert.match(ev?.type === 'error' ? ev.message : '', /synchronous work without an await/);
  assert.equal(wait.started(), 1, 'the call had started before the loop');
  await within(wait.stopped, 1000, 'the call saw its signal abort');
});

test('a body whose calls all finished is not logged', async (t) => {
  const warn = t.mock.method(console, 'warn', () => { /* captured */ });
  const fn = await lambda('(args: {}): Promise<unknown> { return tool.quick({}); }');
  assert.deepEqual(await last(runFunction(machineWith([quick]), ctxFor(new AbortController().signal), fn, [{}])),
                   { type: 'result', value: 'quick' });
  assert.equal(warn.mock.callCount(), 0);
});

test('the tool box counts calls in flight, and a failed call left alone is handled', async (t) => {
  const escaped: unknown[] = [];
  const onUnhandled = (e: unknown): void => { escaped.push(e); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });

  const box = makeToolBox(machineWith([failing, quick]), { session: { id: 's1' } as never, signal: new AbortController().signal });
  const proxy = box.tool as unknown as Record<string, (p: object) => Promise<unknown>>;
  void proxy['fail']!({});
  const ok = proxy['quick']!({});
  assert.equal(box.inFlight(), 2);
  assert.equal(await ok, 'quick');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(box.inFlight(), 0);
  assert.deepEqual(escaped, []);
  await assert.rejects(proxy['fail']!({}), /failed/, 'a caller that awaits still sees the rejection');
});

test('a timer left by a body cannot start a tool call once the body has settled', async () => {
  const wait = waiter();
  const fn = await lambda("(args: {}): Promise<string> { setTimeout(() => { void tool.wait({}); }, 10); return 'done'; }");
  assert.deepEqual(await last(runFunction(machineWith([wait]), ctxFor(new AbortController().signal), fn, [{}])),
                   { type: 'result', value: 'done' });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(wait.started(), 0, 'refused before the tool started');
});
