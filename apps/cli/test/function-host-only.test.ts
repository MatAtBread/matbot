import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeToolBox } from '../../../plugin-api/src/index.ts';
import type { MatbotMachine, Tool, InvokeToolOptions } from '../../../plugin-api/src/index.ts';
import { createVmFunctionRunner } from '@matatbread/matbot-function-runner-node';

// The runner's one hole: shadowing `process` and `globalThis` by NAME left every function's `.constructor`
// — a property, not a name — compiling strings in the global scope, where the real ones are. So the
// constructors (and `process.getBuiltinModule`) now refuse a body however it reaches them, while host code
// — including a tool the body calls — keeps them exactly as they were.

const runner = createVmFunctionRunner(2000);
const noLoader = { importModule: (): Promise<never> => Promise.reject(new Error('no loader in this test')) };
const REFUSED = /is not available to a function body/;
const body = (src: string) => runner.compile(`(async function (a, b) { ${src} })`);

test('every route to a function constructor is refused to a body', async () => {
  for (const src of [
    `return console.log.constructor('return 1')();`,
    `return Function('return 1')();`,
    `return new Function('return 1')();`,
    `return (async () => {}).constructor('return 1')();`,
    `return Reflect.construct(Object.getPrototypeOf(function* () {}).constructor, ['yield 1']);`,
    `return Object.getPrototypeOf(async function* () {}).constructor('yield 1');`,
    `return ['return 1'].map(Function)[0]();`,
    `await null; await new Promise(r => setTimeout(r, 1)); return console.log.constructor('return 1')();`,
    `return new Promise((res, rej) => setTimeout(() => { try { res(console.log.constructor('return 1')()); } catch (e) { rej(e); } }, 1));`,
    `return Promise.resolve('return 1').then(Function).then(g => g());`,
    // A function the body names after the runner's own boundary is still body code.
    `function matbotHostCall() { return console.log.constructor('return 1')(); } return matbotHostCall();`,
    // Tampering with the stack it is judged by makes it unreadable, which is refused.
    `Error.stackTraceLimit = 0; return console.log.constructor('return 1')();`,
    `Error.prepareStackTrace = () => []; return console.log.constructor('return 1')();`,
  ]) {
    await assert.rejects(body(src)(noLoader), REFUSED, src);
  }
});

test("a body's function is still the body's when host code calls it later", async () => {
  // Returned, then serialised by whoever handles the result — long after the call, outside it.
  const r = await body(`return { toJSON() { return console.log.constructor('return 1')(); } };`)(noLoader);
  assert.throws(() => JSON.stringify(r), REFUSED);
  // A listener on something the body was handed, fired by the host.
  const ac = new AbortController();
  const seen: unknown[] = [];
  await body(`a.addEventListener('abort', () => { try { console.log.constructor('return 1')(); } catch (e) { b.push(e); } });`)(noLoader, ac.signal, seen);
  ac.abort();
  assert.match(String(seen[0]), REFUSED);
});

test('process.getBuiltinModule is refused to a body that is handed process anyway', async () => {
  await assert.rejects(body(`return a.getBuiltinModule('node:fs');`)(noLoader, process), REFUSED);
});

test('host code is untouched, identity included', () => {
  assert.equal(new Function('return 7')(), 7);
  assert.equal(Function('return 8')(), 8);
  const f = function () { /* */ };
  assert.equal(f.constructor, Function);
  assert.ok(f instanceof Function);
  assert.equal((async () => { /* */ }).constructor.name, 'AsyncFunction');
  assert.equal(typeof process.getBuiltinModule('node:os').arch, 'function');
});

// A tool the body calls is host code acting for it — and the tool-types validators compile with `new
// Function` at the executor, so refusing it there would refuse every call a body makes.
function machineWith(tools: Tool[]): MatbotMachine {
  const reg = new Map(tools.map(t => [t.name, t]));
  return { tools: { list: () => [...reg.values()], resolve: (n: string) => reg.get(n) ?? null } } as unknown as MatbotMachine;
}
const compiles: Tool = {
  name: 'compiles', description: '', inputSchema: { type: 'object' },
  executor: { execute: async function* (p: unknown) {
    const now = new Function('return "sync"')() as string;
    await null;
    yield { type: 'result', value: `${now}+${new Function('return "async"')() as string}:${JSON.stringify(p)}` };
  } } as Tool['executor'],
};
const call = { session: { id: 's', messages: [] }, signal: new AbortController().signal } as unknown as InvokeToolOptions;

test("a tool the body calls keeps the constructors, and the body's params cannot carry code across", async () => {
  const { tool } = makeToolBox(machineWith([compiles]), call, { hostCall: fn => runner.hostCall!(fn) });
  assert.equal(await body(`return a.compiles({ x: 1 });`)(noLoader, tool), 'sync+async:{"x":1}');
  // Copied before the boundary, in the body's code: the getter runs as the body's, and is refused there.
  await assert.rejects(body(`return a.compiles({ get x() { return console.log.constructor('return 1')(); } });`)(noLoader, tool), REFUSED);
  // A function cannot be copied at all, so none reaches the tool to be called as host code.
  await assert.rejects(body(`return a.compiles({ toString() { return 'x'; } });`)(noLoader, tool), /could not be cloned/);
});

test('a granted import loads as host code', async () => {
  const node = await runner.import!('node:os') as { arch: () => string };
  assert.equal(typeof node.arch(), 'string');
});

// Last, because it cannot be undone: a body that makes the stack unreadable for good leaves nothing able to
// tell its code from the host's, so the constructors refuse everyone from then on. Failing closed costs
// this process its `new Function` until a restart, which beats a body that can switch the check off.
test('a body that makes the stack unreadable is refused, and so is everyone after it', async () => {
  const src = `Object.defineProperty(Error, 'prepareStackTrace', { value: () => [], configurable: false }); return console.log.constructor('return 1')();`;
  await assert.rejects(body(src)(noLoader), REFUSED);
  assert.throws(() => new Function('return 1'), REFUSED);
});
