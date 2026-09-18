import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeToolBox } from '../../../plugin-api/src/index.ts';
import type { MatbotMachine, Tool, InvokeToolOptions } from '../../../plugin-api/src/index.ts';

// A tool whose work is a side effect yields no `result` event — deliberately: `function-tools` omits it
// when a body returns nothing, and the triggers dispatcher fires only on a yielded result. The proxy
// nevertheless drained through `toolResult`, which throws on a missing result, so the one calling surface
// meant to be silent was the one that failed with "Tool produced no result".
//
// The case that throw existed to catch — a body declaring a DATA result and not producing one — is caught
// where the types are instead: the snippet checker runs with `noImplicitReturns`, so it cannot reach here
// from a checked definition.

function fakeMachine(tools: Tool[]): MatbotMachine {
  const reg = new Map(tools.map(t => [t.name, t]));
  return {
    tools: {
      list:     () => [...reg.values()],
      resolve:  (n: string) => reg.get(n) ?? null,
      register: (t: Tool) => { reg.set(t.name, t); },
      remove:   (n: string) => reg.delete(n),
    },
  } as unknown as MatbotMachine;
}

const call = {
  session: { id: 's1', messages: [] },
  signal:  new AbortController().signal,
} as unknown as InvokeToolOptions;

const tool = (name: string, body: () => AsyncIterable<never> | AsyncGenerator<unknown>): Tool => ({
  name, description: '', inputSchema: { type: 'object' },
  executor: { execute: body as Tool['executor']['execute'] },
});

const sideEffect = tool('notify_someone', async function* () {
  yield { type: 'stdout', chunk: 'sent\n' };
});
const dataTool   = tool('read_thing', async function* () {
  yield { type: 'result', value: { rows: 3 } };
});
const failing    = tool('broken_thing', async function* () {
  yield { type: 'error', message: 'upstream exploded' };
});

test('a tool that yields no result resolves to undefined rather than throwing', async () => {
  const { tool: proxy } = makeToolBox(fakeMachine([sideEffect]), call);
  assert.equal(await proxy.notify_someone({}), undefined);
});

test('a yielded result still comes back unchanged', async () => {
  const { tool: proxy } = makeToolBox(fakeMachine([dataTool]), call);
  assert.deepEqual(await proxy.read_thing({}), { rows: 3 });
});

test('an error event still throws, carrying its message', async () => {
  // The silence is only about a MISSING result. A tool that reports a failure must still reach the caller
  // as one — otherwise the change would turn every failed call into a silent `undefined`.
  const { tool: proxy } = makeToolBox(fakeMachine([failing]), call);
  await assert.rejects(() => proxy.broken_thing({}) as Promise<unknown>, /upstream exploded/);
});
