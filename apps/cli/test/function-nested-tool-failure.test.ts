import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { buildAsyncFn, runFunction, type CompileHost } from '@matatbread/matbot-function-tools';
import { makeToolBox } from '../../../plugin-api/src/index.ts';
import type { InvokeToolOptions, MatbotMachine, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import { VaultImpl, permitted } from '@matatbread/matbot-core';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

// A tool a body called failed, and everything it said beyond its message was dropped on the way out: the
// proxy's drain threw `new Error(ev.message)`. A `bash` script that exited 127 reached the model as
// "Process exited with code 127", its stderr (`curl: command not found`) gone — so the model, with
// nothing to go on, ran the same body nine times in a row (a Maxie session, 2026-11-17). The direct call
// to the same tool always carried stdout and stderr; only the composed one lost them.

const runner = createVmFunctionRunner(2000);
const host: CompileHost = { TypeScriptStripper: { strip: (s: string) => stripTypeScriptTypes(s) }, FunctionRunner: runner };

const SECRET = 'sk_live_0123456789abcdef';

// Stands in for `bash`: an error event carrying an exit code, the script's output, and a failure class.
const script: Tool = {
  name: 'script', description: '', inputSchema: { type: 'object' },
  executor: {
    async *execute(params) {
      const echo = (params as { echo?: string }).echo ?? '';
      yield { type: 'error', message: 'Process exited with code 127', code: 127, failure: 'invalid',
              stdout: `partial output ${echo}\n`, stderr: 'bash: line 4: curl: command not found\n' };
    },
  },
};

function machineWith(withRunner: boolean): MatbotMachine {
  return {
    tools: { list: () => [script], resolve: (n: string) => (n === 'script' ? script : null), register: () => {}, remove: () => false },
    ...(withRunner ? { FunctionRunner: runner } : {}),
  } as unknown as MatbotMachine;
}

async function run(def: string, withRunner: boolean): Promise<ToolEvent | undefined> {
  const ctx = {
    callId: 'c1', session: { id: 's1', messages: [] }, signal: new AbortController().signal, vault: new VaultImpl({}),
    prompt: () => Promise.reject(new Error('non-interactive')),
    gate: () => Promise.resolve(permitted('user')),
  } as unknown as ToolContext;
  const fn = await buildAsyncFn(host, def, []);
  let last: ToolEvent | undefined;
  for await (const ev of runFunction(machineWith(withRunner), ctx, fn, [], { tool: 'probe', source: def })) {
    if (ev.type === 'error' || ev.type === 'result') last = ev;
  }
  return last;
}

test('the proxy throws an error that keeps everything the error event said', async () => {
  const call = { session: { id: 's1', messages: [] }, signal: new AbortController().signal } as unknown as InvokeToolOptions;
  const { tool } = makeToolBox(machineWith(false), call);
  const err = await (tool as unknown as Record<string, (p: unknown) => Promise<unknown>>)['script']!({}).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'Process exited with code 127');
  assert.deepEqual({ ...err }, { code: 127, failure: 'invalid', stdout: 'partial output \n', stderr: 'bash: line 4: curl: command not found\n' });
});

for (const withRunner of [true, false]) {
  const label = withRunner ? 'node runner' : 'no runner';

  test(`a body that lets a call's failure escape reports its stdout, stderr and failure class (${label})`, async () => {
    const final = await run(`probe() { return tool.script({}); }`, withRunner);
    assert.deepEqual(final, {
      type: 'error', message: 'Process exited with code 127', failure: 'invalid',
      stdout: 'partial output \n', stderr: 'bash: line 4: curl: command not found\n',
    }, 'and no `code`: the callee\'s exit status is not tool_function\'s');
  });

  test(`a body that catches the failure can read the same fields (${label})`, async () => {
    const final = await run(`probe() { return tool.script({}).then(() => null, e => ({ code: e.code, stderr: e.stderr })); }`, withRunner);
    assert.deepEqual(final, { type: 'result', value: { code: 127, stderr: 'bash: line 4: curl: command not found\n' } });
  });

  test(`a secret the body stored is redacted from the failed call's output as well (${label})`, async () => {
    // Assembled at run time: a value written out in the body is refused, being in the conversation already.
    const [head, tail] = SECRET.split('_live_');
    const final = await run(
      `probe() { const key = ['${head}', '${tail}'].join('_live_'); return context.writeSecret('ACME_KEY', key).then(() => tool.script({ echo: key })); }`,
      withRunner,
    );
    assert.equal(final?.type, 'error');
    assert.ok(!JSON.stringify(final).includes(SECRET), JSON.stringify(final));
    assert.match(JSON.stringify(final), /partial output \[REDACTED\]/);
  });
}

test('a body\'s own error passes on no tool detail it did not carry', async () => {
  const final = await run(`probe() { const e = new Error('mine'); e.code = 'E_MINE'; e.stderr = 42; throw e; }`, true);
  assert.deepEqual(final, { type: 'error', message: 'mine' });
});
