import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plugin as workspacePlugin } from '../../../plugins/workspace/src/index.ts';
import type { Tool, ToolContext, ToolEvent } from '../../../plugin-api/src/index.ts';

// `prefix` selects by whole segments, which is right — but it was implemented as a STRICT ancestor
// (`dir + '/'`), so a prefix naming one complete file matched nothing and said so with an empty array.
// That is indistinguishable from "no such file", and it made a single file unaddressable through `list`.

const ENTRIES = [
  { name: 'dream_runs/90m_log.txt', size: 10 },
  { name: 'llm-is-an-alu-v2.md',    size: 20 },
  { name: 'self test.md',           size: 30 },
  { name: 'charts/data.csv',        size: 40 },
];

const ctx = {
  files: {
    list: async function* () { for (const e of ENTRIES) yield e; },
    getByName: async (n: string) => ENTRIES.find(e => e.name === n) ?? null,
  },
  signal: new AbortController().signal,
} as unknown as ToolContext;

const workspaceTool = (workspacePlugin.tools ?? [])[0] as Tool;

async function list(prefix?: string): Promise<string[]> {
  const events: ToolEvent<unknown>[] = [];
  const input = prefix === undefined ? { action: 'list' } : { action: 'list', prefix };
  for await (const ev of workspaceTool.executor.execute(input, ctx)) events.push(ev);
  const result = events.find(e => e.type === 'result');
  assert.ok(result && result.type === 'result', `expected a result, got ${JSON.stringify(events)}`);
  return (result.value as Array<{ name: string }>).map(f => f.name);
}

test('a prefix equal to a complete file name selects that one file', async () => {
  assert.deepEqual(await list('self test.md'),           ['self test.md']);
  assert.deepEqual(await list('dream_runs/90m_log.txt'), ['dream_runs/90m_log.txt']);
  assert.deepEqual(await list('llm-is-an-alu-v2.md'),    ['llm-is-an-alu-v2.md']);
});

test('segment matching is unchanged — a partial segment still matches nothing', async () => {
  // The property that made the strict-ancestor form right in the first place: "char" is not a segment
  // of "charts/data.csv", so it must not select it.
  assert.deepEqual(await list('charts'),     ['charts/data.csv']);
  assert.deepEqual(await list('charts/'),    ['charts/data.csv']);
  assert.deepEqual(await list('char'),       []);
  assert.deepEqual(await list('dream_runs'), ['dream_runs/90m_log.txt']);
});

test('an omitted prefix lists the whole workspace', async () => {
  assert.deepEqual((await list()).sort(), ENTRIES.map(e => e.name).sort());
});
