// A stand-in process for function-body-failures.test.ts: loads the node FunctionRunner (which installs its
// containment), then fails in the way argv[2] names, and says it is still alive if it is.
import { stripTypeScriptTypes } from 'node:module';
import { buildAsyncFn, runFunction } from '../../../../plugins/function-tools/src/index.ts';
import { createVmFunctionRunner } from '../../../../plugins/function-runner-node/src/index.ts';
import type { MatbotMachine, Tool, ToolContext } from '../../../../plugin-api/src/index.ts';

const runner = createVmFunctionRunner(200);
const late: Tool = {
  name: 'late', description: '', inputSchema: { type: 'object' },
  executor: { async *execute() { process.stdout.write('late ran\n'); yield { type: 'result', value: 'late' }; } },
};
const fails: Tool = {
  name: 'fails', description: '', inputSchema: { type: 'object' },
  executor: { async *execute() { throw new Error('the late call failed'); } },
};
const tools = new Map([[late.name, late], [fails.name, fails]]);
const machine = { tools: { list: () => [...tools.values()], resolve: (n: string) => tools.get(n) ?? null } } as unknown as MatbotMachine;
const ctx = { callId: 'c1', session: { id: 's1' }, signal: new AbortController().signal, prompt: () => Promise.reject(new Error('no')) } as unknown as ToolContext;

switch (process.argv[2]) {
  case 'body': {
    // Every way a body can leave a failure behind it: a late tool call that fails, awaited in a timer; a
    // throw in a timer; a bare rejection; a rejection with no stack. And a late call that succeeds, which runs.
    const fn = await buildAsyncFn({ TypeScriptStripper: { strip: (s: string) => stripTypeScriptTypes(s) }, FunctionRunner: runner },
      `(args: {}): Promise<string> {
        setTimeout(async () => { await tool.late({}); }, 5);
        setTimeout(async () => { await tool.fails({}); }, 5);
        setTimeout(() => { throw new Error('thrown in a timer'); }, 5);
        Promise.reject(new Error('rejected at once'));
        Promise.reject(1);
        return 'done';
      }`, ['args']);
    for await (const ev of runFunction(machine, ctx, fn, [{}])) if (ev.type === 'result') process.stdout.write(`result:${String(ev.value)}\n`);
    setTimeout(() => { process.stdout.write('alive\n'); }, 100);
    break;
  }
  case 'host-rejection':
    void Promise.reject(new Error('a host rejection'));
    setTimeout(() => { process.stdout.write('alive\n'); }, 100);
    break;
  case 'host-throw':
    setTimeout(() => { throw new Error('a host throw'); }, 5);
    setTimeout(() => { process.stdout.write('alive\n'); }, 100);
    break;
}
