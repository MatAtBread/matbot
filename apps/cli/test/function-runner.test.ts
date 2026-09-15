import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { buildAsyncFn, runFunction, parsePackage, buildPackageFn, exportFn } from '@matatbread/matbot-function-tools';
import { invokeTool, parseConfig } from '@matatbread/matbot-core';
import type { MatbotMachine, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { createVmFunctionRunner, FUNCTION_SYNC_LIMIT_MS } from '../src/function-runner.ts';

// A tool_function body runs on the daemon's one event loop. 18da1564 (2026-09-15) froze every session for
// 260s on a model-authored `while` whose step never advanced; it ended only because the array it grew hit
// the length limit. These pin the runner that bounds such work, and the abort wiring for loops that await.

const stripper = { strip: (s: string) => stripTypeScriptTypes(s) };
const runner = createVmFunctionRunner(200);
const LIMIT = /synchronous work without an await/;

function machineWith(tools: Tool[] = []): MatbotMachine {
  const reg = new Map(tools.map(t => [t.name, t]));
  return {
    tools: {
      list: () => [...reg.values()],
      resolve: (n: string) => reg.get(n) ?? null,
      register: (t: Tool) => { reg.set(t.name, t); },
      remove: (n: string) => reg.delete(n),
    },
  } as unknown as MatbotMachine;
}

const ctxFor = (signal: AbortSignal = new AbortController().signal): ToolContext => ({
  callId: 'c1', session: { id: 's1' }, signal,
  prompt: () => Promise.reject(new Error('non-interactive')),
}) as unknown as ToolContext;

async function last(events: AsyncIterable<ToolEvent>): Promise<ToolEvent | undefined> {
  let final: ToolEvent | undefined;
  for await (const ev of events) final = ev;
  return final;
}

const lambda = (src: string) => buildAsyncFn(stripper, src, ['args'], runner);

function pingTool(): Tool & { calls: () => number } {
  let calls = 0;
  return {
    name: 'ping', description: '', inputSchema: { type: 'object' },
    executor: { async *execute() { calls++; yield { type: 'result', value: calls }; } },
    calls: () => calls,
  };
}
const message = (ev: ToolEvent | undefined): string => (ev?.type === 'error' ? ev.message : `not an error: ${JSON.stringify(ev)}`);

test('a loop that never awaits is stopped at the limit, and the daemon carries on', async () => {
  const started = Date.now();
  const ev = await last(runFunction(machineWith(), ctxFor(), await lambda('(args: {}): Promise<number> { let d = 1; while (d > 0) { d = d; } return d; }'), [{}]));
  assert.match(message(ev), LIMIT);
  assert.ok(Date.now() - started < 2000, `stopped near the limit, not left to run (${Date.now() - started}ms)`);
  assert.equal(await new Promise(r => setTimeout(() => r('alive'), 0)), 'alive', 'the event loop is free again');
});

// Not tested, because not covered: a loop AFTER an await. See createVmFunctionRunner for why the design
// that covers it (a context per run, drained inside timed evaluations) was withdrawn — its timeout aborts
// the process when async hooks are enabled, as they are under this very test runner.

test('a body keeps the globals it had, and its input is its own data', async () => {
  const fn = await lambda("(args: { xs: number[] }): Promise<string> { const u = new URL('https://x.test/a?b=1'); await new Promise<void>(r => queueMicrotask(r)); return [typeof fetch, u.searchParams.get('b'), new TextEncoder().encode('hi').length, args.xs instanceof Array, await tool.ping({})].join(','); }");
  assert.deepEqual(await last(runFunction(machineWith([pingTool()]), ctxFor(), fn, [{ xs: [1] }])), { type: 'result', value: 'function,1,2,true,1' });
});

test('awaiting is not work: a call slower than the limit completes', async () => {
  const ev = await last(runFunction(machineWith(), ctxFor(), await lambda("(args: {}): Promise<string> { await new Promise(r => setTimeout(r, 600)); return 'slow but fine'; }"), [{}]));
  assert.deepEqual(ev, { type: 'result', value: 'slow but fine' });
});

test('a package export is bounded too, being called inside the timed run', async () => {
  const spin = 'export function spin(args: {}): number { for (;;) {} }';
  const spinning = await buildPackageFn(stripper, spin, parsePackage('P', spin), runner);
  assert.match(message(await last(runFunction(machineWith(), ctxFor(), exportFn(spinning, 'spin'), [{}]))), LIMIT);

  const ok = 'function double(n: number): number { return n * 2; }\nexport function twice(args: { n: number }): number { return double(args.n); }';
  const working = await buildPackageFn(stripper, ok, parsePackage('P', ok), runner);
  assert.deepEqual(await last(runFunction(machineWith(), ctxFor(), exportFn(working, 'twice'), [{ n: 21 }])), { type: 'result', value: 42 });
});

test('a run started inside another takes its own call, and a loop there is still stopped', async () => {
  const inner = runner.compile([], 'return 7;');
  assert.equal(await runner.compile(['inner'], 'return inner();')(inner), 7);
  const spinning = runner.compile([], 'for (;;) {}');
  await assert.rejects(runner.compile(['inner'], 'return inner();')(spinning), LIMIT);
  assert.equal(await runner.compile(['a', 'b'], 'return a + b;')(2, 3), 5, 'the runner is usable after a stopped run');
});

test('with no runner the body runs directly, as it did before', async () => {
  const fn = await buildAsyncFn(stripper, "(args: {}): Promise<string> { return 'direct'; }", ['args']);
  assert.deepEqual(await last(runFunction(machineWith(), ctxFor(), fn, [{}])), { type: 'result', value: 'direct' });
});

test('aborting ends the call, and a body looping over tool calls then stops itself', async () => {
  // Awaiting a tool each iteration is what lets it die: after the abort that call is refused and throws.
  // A body awaiting only timers would keep running unseen — nothing in-process can stop it — though the
  // call still ends on the abort.
  const ping = pingTool();
  const ac = new AbortController();
  const fn = await lambda('(args: {}): Promise<void> { for (;;) { await tool.ping({}); await new Promise(r => setTimeout(r, 5)); } }');
  setTimeout(() => ac.abort(), 50);
  const started = Date.now();
  assert.match(message(await last(runFunction(machineWith([ping]), ctxFor(ac.signal), fn, [{}]))), /Cancelled/);
  assert.ok(Date.now() - started < 1000, 'returned promptly after the abort');
  const atAbort = ping.calls();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(ping.calls(), atAbort, 'no tool was started after the abort');
});

test('a tool call on a cancelled call is refused before the tool starts', async () => {
  let started = false;
  const probe: Tool = {
    name: 'probe', description: '', inputSchema: { type: 'object' },
    executor: { async *execute() { started = true; yield { type: 'result', value: 1 }; } },
  };
  const ac = new AbortController();
  ac.abort();
  assert.throws(() => invokeTool(machineWith([probe]), 'probe', {}, { session: { id: 's1' } as never, signal: ac.signal }), /was not started: the call was cancelled/);
  assert.equal(started, false);
});

test('function_timeout_ms comes from matbot.yaml: absent is the default, 0 is a value, a typo is refused', () => {
  assert.equal(FUNCTION_SYNC_LIMIT_MS, 10_000);
  assert.equal(parseConfig('ephemeral: true\n').functionTimeoutMs, undefined, 'absent ⇒ the host default applies');
  assert.equal(parseConfig('function_timeout_ms: 2500\n').functionTimeoutMs, 2500);
  // 0 must survive parsing as a value: it is what turns the runner off, not what leaves it at the default.
  assert.equal(parseConfig('function_timeout_ms: 0\n').functionTimeoutMs, 0);
  for (const bad of ['-1', '1.5', 'soon']) {
    assert.throws(() => parseConfig(`function_timeout_ms: ${bad}\n`), /function_timeout_ms/, bad);
  }
});
