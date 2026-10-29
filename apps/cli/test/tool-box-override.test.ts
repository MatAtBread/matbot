import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeToolBox } from '../../../plugin-api/src/index.ts';
import type { MatbotMachine, Tool, InvokeToolOptions, ToolContext, PromptFn } from '../../../plugin-api/src/index.ts';

// `toolInContext(override)` exists to run one call under another provider. It merged the WHOLE override
// over the call's context, so the code calling it — a model-authored body — could hand a callee its own
// `prompt`, and every gate that callee asked would be answered by the body: no escape needed, just the
// documented surface. It could equally swap the session the callee acts on, or the turn tools it resolves.

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

const humanPrompt: PromptFn = async () => { throw new Error('the human channel'); };
const call = {
  session: { id: 'mine', messages: [] },
  signal:  new AbortController().signal,
  prompt:  humanPrompt,
} as unknown as InvokeToolOptions;

let seen: ToolContext | undefined;
const probe: Tool = {
  name: 'probe', description: '', inputSchema: { type: 'object' },
  executor: { execute: async function* (_p: unknown, ctx: ToolContext) { seen = ctx; yield { type: 'result', value: null }; } } as Tool['executor'],
};

test('an override changes the provider and nothing else it may not', async () => {
  const { toolInContext } = makeToolBox(fakeMachine([probe]), call);
  const forged: PromptFn = async () => ({ answer: 'yes' }) as never;
  await toolInContext({
    provider: 'cheap',
    ...{ prompt: forged, session: { id: 'someone-elses', messages: [] }, turnTools: [] } as object,
  }).probe({});
  assert.equal(seen?.provider, 'cheap');
  assert.equal(seen?.prompt, humanPrompt, 'the gates still ask the human channel, never one the caller supplied');
  assert.equal(seen?.session.id, 'mine', 'and the callee acts on the calling session');
  assert.equal(seen?.turnTools, undefined);
});

test('with no override the call context passes through whole', async () => {
  const { tool, toolInContext } = makeToolBox(fakeMachine([probe]), { ...call, provider: 'p' });
  await tool.probe({});
  assert.equal(seen?.provider, 'p');
  await toolInContext().probe({});
  assert.equal(seen?.prompt, humanPrompt);
  assert.equal(seen?.provider, 'p');
});

test('an override signal can cancel a call sooner, never keep it going later', async () => {
  const turn = new AbortController();
  const { toolInContext } = makeToolBox(fakeMachine([probe]), { ...call, signal: turn.signal });

  const deadline = new AbortController();
  await toolInContext({ signal: deadline.signal }).probe({});
  const sooner = seen!.signal;
  assert.equal(sooner.aborted, false);
  deadline.abort();
  assert.equal(sooner.aborted, true, "the override's own abort reaches the callee");

  // A signal that never aborts does not shield the callee from the turn being stopped.
  await toolInContext({ signal: new AbortController().signal }).probe({});
  const later = seen!.signal;
  turn.abort();
  assert.equal(later.aborted, true, "the turn's abort still reaches the callee");
});
