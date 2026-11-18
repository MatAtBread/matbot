import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolTypesPlugin } from '@matatbread/matbot-tool-types';
import type { MatbotMachine, Tool, ToolTypeIndex } from '@matatbread/matbot-plugin-api';

// The snippet check resolves `@matatbread/matbot-plugin-api` for the dts it prefixes, and used to look only
// from the project directory. Where nothing is installed there — a pnpm project, a globally installed CLI, a
// directory holding only matbot.yaml — the import failed, `tool` was `any`, and a function body calling a
// tool with the wrong argument, an unknown property or a misspelt name passed the check and failed (or
// silently misbehaved) at run time. Found by installing tool-types + function-tools into exactly such a
// directory: `tool.greet({ opts: { times: '2' } })` passed and ran.

const greet: Tool = {
  name: 'greet', description: 'a defined function', inputSchema: { type: 'object' },
  toolContract: `ToolContract<string, { opts: Omit<{ name: string; times: number; secret: boolean }, 'secret'> }>`,
  executor: { execute: () => (async function* () {})() },
};

test('a function body is checked against the real tool types where the project has nothing installed', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'matbot-bare-project-'));
  await writeFile(join(projectDir, 'matbot.yaml'), 'plugins: []\n');
  try {
    let index: ToolTypeIndex | undefined;
    const machine = {
      projectDir,
      Notifier: { consume: () => {}, notify: () => {}, subscribe: () => (async function* () {})() },
      tools: { list: () => [greet], resolve: (n: string) => (n === 'greet' ? greet : null), register() {}, remove() {}, removeByPlugin() {} },
      register: async (_k: string, v: unknown) => { index = v as ToolTypeIndex; },
    } as unknown as MatbotMachine;
    await createToolTypesPlugin().setup?.(machine);
    assert.ok(index !== undefined);

    const check = (body: string) => index!.check(`async function __fn() ${body}`);

    assert.equal((await check(`{ const s: string = await tool.greet({ opts: { name: 'Ann', times: 2 } }); return s.length; }`)).ok, true,
                 'a correct call passes, its result typed');
    for (const [what, body] of [
      ['a wrong argument type', `{ return await tool.greet({ opts: { name: 'Ann', times: '2' } }); }`],
      ['an unknown property',   `{ return await tool.greet({ opts: { name: 'Ann', times: 2, secret: true } }); }`],
      ['a tool that does not exist', `{ return await tool.greet_typo({}); }`],
      ['`tool` used as anything',    `{ const n: number = tool; return n; }`],
    ] as const) {
      assert.equal((await check(body)).ok, false, `${what} is refused`);
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
