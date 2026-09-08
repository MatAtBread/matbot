import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistryImpl, TOOL_INPUT_INVALID } from '@matatbread/matbot-core';
import type { ToolInputValidator } from '@matatbread/matbot-core';
import type { Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';

// Validation sits on the EXECUTOR, not in a `toolcall` hook, because the hook is a runner channel and
// therefore guards exactly one of the three doors:
//   core/src/runner.ts:596        the model's path      — runs the hook chain first
//   frontend/web server.ts:857    POST /tools/:name     — no hooks at all
//   plugin-api/invoke-tool.ts:76  invokeTool()          — no hooks at all
// A hook leaves the last two open, which is what invites a per-door copy of the check and the drift
// that follows. These tests exercise `executor.execute` directly — the thing all three call — so they
// stand for every door at once.

function stubTool(): { tool: Tool; calls: unknown[] } {
  const calls: unknown[] = [];
  const tool: Tool = {
    name: 'session_action',
    description: 'stub',
    inputSchema: { type: 'object' },
    executor: {
      execute(input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
        calls.push(input);
        return (async function* () { yield { type: 'result', value: 'ran' } as ToolEvent; })();
      },
    },
  };
  return { tool, calls };
}

const validator = (errs: { path: string; message: string }[] | undefined): ToolInputValidator =>
  ({ validateToolCall: async () => errs });

async function drain(it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> {
  const out: ToolEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const CTX = {} as ToolContext;

test('invalid input never reaches the tool, whichever door called it', async () => {
  const { tool, calls } = stubTool();
  const reg = new ToolRegistryImpl(undefined, undefined,
    () => validator([{ path: '.title', message: 'required property missing' }]));
  reg.register(tool);

  const events = await drain(reg.resolve('session_action')!.executor.execute({ action: 'rename' }, CTX));

  assert.equal(events.length, 1, 'a rejected call yields exactly one event');
  const ev = events[0]!;
  assert.equal(ev.type, 'error');
  assert.ok(ev.type === 'error' && ev.message.includes('.title: required property missing'),
    'the field path must reach the caller (and, on the model path, the model)');
  assert.ok(ev.type === 'error' && ev.code === TOOL_INPUT_INVALID, 'a 4xx code, so a transport can answer 422 rather than 500');
  assert.deepEqual(calls, [], 'the tool must not have been executed at all');
});

test('the message names the field, shows what was sent, and caps how much of it', async () => {
  // The value is the difference between an error a model can act on and one it has to guess at, so it
  // is rendered wrapped in its own field name — a fragment the caller can compare against what it sent.
  const one = async (errs: { path: string; message: string; value?: unknown }[]) => {
    const { tool } = stubTool();
    const reg = new ToolRegistryImpl(undefined, undefined, () => validator(errs));
    reg.register(tool);
    const events = await drain(reg.resolve('session_action')!.executor.execute({}, CTX));
    const ev = events[0]!;
    return ev.type === 'error' ? ev.message : '';
  };

  assert.match(await one([{ path: '.x', message: 'never (no value is valid)', value: 8 }]),
    /\.x: never \(no value is valid\), actual value `\{"x":8\}`/);

  // An absent property has no value to show, and JSON cannot carry `undefined` — so no clause at all,
  // rather than a misleading `{}`.
  assert.equal(await one([{ path: '.title', message: 'required property missing' }]),
    'Invalid input for tool "session_action": .title: required property missing');

  // No field name to wrap it in: an array element and the root render the value alone, since the path
  // already says which one it was.
  assert.match(await one([{ path: '.items[0]', message: 'expected string', value: 3 }]),
    /\.items\[0\]: expected string, actual value `3`/);
  assert.match(await one([{ path: '.', message: 'expected object', value: null }]),
    /^Invalid input for tool "session_action": \.: expected object, actual value `null`$/);

  // A rejected attachment must not turn one bad field into the bulk of a turn's context.
  const long = await one([{ path: '.content', message: 'expected object', value: 'x'.repeat(5000) }]);
  assert.ok(long.length < 300, `the rendered value must be capped, got ${long.length} chars`);
  assert.ok(long.endsWith('…`'), 'and be visibly truncated');

  // Rendering must never throw: with validation now on internal calls too, a caller can arrive with a
  // bigint or a cycle, and a throw here would replace the diagnosis with a stack trace.
  const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
  assert.match(await one([{ path: '.a', message: 'expected string', value: cyclic }]), /\.a: expected string/);
  assert.match(await one([{ path: '.b', message: 'expected number', value: 1n }]), /\.b: expected number/);
});

test('valid input runs the tool untouched', async () => {
  const { tool, calls } = stubTool();
  const reg = new ToolRegistryImpl(undefined, undefined, () => validator([]));
  reg.register(tool);

  const events = await drain(reg.resolve('session_action')!.executor.execute({ action: 'list' }, CTX));
  assert.deepEqual(events, [{ type: 'result', value: 'ran' }]);
  assert.deepEqual(calls, [{ action: 'list' }], 'the input passes through byte-for-byte');
});

test('NO OPINION passes through — undefined is not a rejection', async () => {
  const { tool, calls } = stubTool();
  const reg = new ToolRegistryImpl(undefined, undefined, () => validator(undefined));
  reg.register(tool);

  const events = await drain(reg.resolve('session_action')!.executor.execute({ whatever: 1 }, CTX));
  assert.deepEqual(events, [{ type: 'result', value: 'ran' }]);
  assert.deepEqual(calls, [{ whatever: 1 }]);
});

test('with no validator registered, core mandates nothing', async () => {
  // Two ways to have none: the host wired no lookup at all, and a lookup that resolves to undefined
  // (nothing has registered one yet, or it was unloaded). Neither may change behaviour.
  for (const [label, reg] of [
    ['no lookup wired', new ToolRegistryImpl()],
    ['lookup resolves undefined', new ToolRegistryImpl(undefined, undefined, () => undefined)],
  ] as const) {
    const { tool, calls } = stubTool();
    reg.register(tool);
    const events = await drain(reg.resolve('session_action')!.executor.execute({ junk: true }, CTX));
    assert.deepEqual(events, [{ type: 'result', value: 'ran' }], label);
    assert.deepEqual(calls, [{ junk: true }], label);
  }
});

test('the wrapper is applied once, so tool identity is stable', async () => {
  // Wrapped at registration rather than at resolve: `resolve(x) === resolve(x)` still holds, which
  // anything comparing or caching tools relies on.
  const { tool } = stubTool();
  const reg = new ToolRegistryImpl(undefined, undefined, () => validator([]));
  reg.register(tool);
  assert.equal(reg.resolve('session_action'), reg.resolve('session_action'));
  assert.equal(reg.list()[0], reg.resolve('session_action'), 'list() and resolve() agree');
  // The wrapper is transparent in every respect but `executor`.
  const wrapped = reg.resolve('session_action')!;
  assert.equal(wrapped.name, tool.name);
  assert.equal(wrapped.description, tool.description);
  assert.notEqual(wrapped.executor, tool.executor, 'only the executor is replaced');
});

test('builtins seeded through the constructor are guarded too', async () => {
  // The CLI seeds `createBuiltinTools()` this way, so a constructor-seeded tool that skipped the
  // wrapper would leave `about_matbot`/`single_turn` unvalidated while everything else was checked.
  const { tool, calls } = stubTool();
  const reg = new ToolRegistryImpl([tool], undefined,
    () => validator([{ path: '.action', message: 'expected one of "list", "get"' }]));

  const events = await drain(reg.resolve('session_action')!.executor.execute({ action: 'nope' }, CTX));
  assert.equal(events[0]?.type, 'error');
  assert.deepEqual(calls, [], 'a seeded builtin is validated exactly like a registered tool');
});
