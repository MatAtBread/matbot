import { AsyncLocalStorage } from 'node:async_hooks';

// What a body may not reach however it gets there: the four function constructors, which compile a string
// in the GLOBAL scope — outside the wrapper whose parameters shadow `process` and `globalThis` — and
// `process.getBuiltinModule`, which loads any builtin without the import gate. Shadowing a NAME cannot
// close the first: `console.log.constructor` is a property, not a name, and every function has one. So
// the objects themselves are replaced, process-wide, by ones that refuse when the code calling them is a
// body's, and behave exactly as before for everything else.
//
// "A body's" is decided two ways, because each misses what the other sees:
//   - the caller. Body code is compiled with the filename `BODY_FILE`, so a body frame nearer the top of
//     the stack than a `hostCall` frame means the body is calling — directly, through a builtin such as
//     `map`, or as a `toJSON`, getter or listener that host code invoked long after the body returned;
//   - the span. A constructor handed straight to a callback (`promise.then(Function)`) runs with no body
//     frame at all, so each call also runs in an AsyncLocalStorage span that every continuation it
//     schedules inherits, and `hostCall` leaves.
//
// It is not a sandbox. A body shares this process's built-ins, so it can still REWRITE them —
// `Object.prototype`, `JSON`, `Headers.prototype` — and anything that later reads them reads what it
// wrote. That needs a context of its own, and is a different runner.

/** The filename body code is compiled under; no real module can have it. */
export const BODY_FILE = 'tool_function';
const HOST_CALL = 'matbotHostCall';

// Read when this module loads, before any body runs: a body can reassign every one of these, being
// shared built-ins, and the check must not call anything a body could have replaced.
const { apply, construct, defineProperty: defineProp, getOwnPropertyDescriptor: descriptor } = Reflect;
const { isArray } = Array;
const { getPrototypeOf } = Object;
const SPAN_STORE = AsyncLocalStorage.prototype.getStore;
const SPAN_RUN = AsyncLocalStorage.prototype.run;
const SPAN_EXIT = AsyncLocalStorage.prototype.exit;
const CallSites = ((): { file: (c: unknown) => unknown; fn: (c: unknown) => unknown } => {
  const prepare = descriptor(Error, 'prepareStackTrace');
  defineProp(Error, 'prepareStackTrace', { value: (_: unknown, s: unknown[]) => s, writable: true, configurable: true });
  const sites = new Error().stack as unknown as object[];
  restore('prepareStackTrace', prepare);
  const proto = getPrototypeOf(sites[0]) as { getFileName: () => unknown; getFunctionName: () => unknown };
  const { getFileName, getFunctionName } = proto;
  return { file: c => apply(getFileName, c, []), fn: c => apply(getFunctionName, c, []) };
})();

interface Shared { span: AsyncLocalStorage<true>; hostFiles: string[] }
// One per process, so a reloaded copy of this module shares the span and the replacements, and adds its
// own file to those whose `hostCall` frames count.
const KEY = Symbol.for('matbot.functionRunner.hostOnly');
const shared: Shared = ((globalThis as Record<symbol, Shared | undefined>)[KEY] ??= install());
const HERE = import.meta.url;
if (!shared.hostFiles.includes(HERE)) shared.hostFiles.push(HERE);

/** Run `fn` as a body: what it calls, and whatever it schedules, is refused the host's code builders. */
export function inBody<T>(fn: () => T): T {
  return apply(SPAN_RUN, shared.span, [true, fn]) as T;
}

/** Run `fn` as host code acting for a body (FunctionRunner.hostCall). The name is what the caller check
 *  looks for, together with this file — a body may name a function the same, but not compile one here. */
export function hostCall<T>(fn: () => T): T {
  return matbotHostCall(fn);
}
function matbotHostCall<T>(fn: () => T): T {
  return apply(SPAN_EXIT, shared.span, [fn]) as T;
}

/** Whether the code calling right now is a body's. Fails closed: a stack it cannot read is a body's. */
function forBody(): boolean {
  const sites = stack();
  if (sites === undefined) return true;
  for (let i = 0; i < sites.length; i++) {
    const file = CallSites.file(sites[i]);
    if (file === BODY_FILE) return true;
    if (CallSites.fn(sites[i]) === HOST_CALL) {
      for (let j = 0; j < shared.hostFiles.length; j++) if (file === shared.hostFiles[j]) return false;
    }
  }
  return apply(SPAN_STORE, shared.span, []) === true;
}

// The structured stack, whatever a body did to `Error`: both properties are set by descriptor, never by
// assignment, so a setter a body planted is not run, and both are put back as they were found. A body
// that made either unconfigurable has made the stack unreadable, and is refused for it.
function stack(): unknown[] | undefined {
  const limit = descriptor(Error, 'stackTraceLimit');
  const prepare = descriptor(Error, 'prepareStackTrace');
  try {
    // `Reflect.defineProperty` reports a refusal by returning false, never by throwing.
    if (!defineProp(Error, 'stackTraceLimit', { value: Infinity, writable: true, configurable: true })) return undefined;
    if (!defineProp(Error, 'prepareStackTrace', { value: (_: unknown, s: unknown[]) => s, writable: true, configurable: true })) return undefined;
    const sites = new Error().stack as unknown;
    return isArray(sites) ? sites : undefined;
  } catch {
    return undefined;
  } finally {
    try { restore('stackTraceLimit', limit); restore('prepareStackTrace', prepare); }
    catch { /* unconfigurable: left as the body made it */ }
  }
}

function restore(key: 'stackTraceLimit' | 'prepareStackTrace', was: PropertyDescriptor | undefined): void {
  if (was !== undefined) defineProp(Error, key, was);
  else delete (Error as unknown as Record<string, unknown>)[key];
}

function refusal(what: string): Error {
  return new Error(
    `${what} is not available to a function body: it would run code or load a module in matbot's own scope, ` +
    "around the runner and every permission gate. Write the code directly, import a module with 'await import(…)' " +
    '(the user is asked), or call a tool.',
  );
}

function install(): Shared {
  const span = new AsyncLocalStorage<true>();
  const prototypes = [
    Function.prototype,
    getPrototypeOf(async function () { /* AsyncFunction */ }) as object,
    getPrototypeOf(function* () { /* GeneratorFunction */ }) as object,
    getPrototypeOf(async function* () { /* AsyncGeneratorFunction */ }) as object,
  ];
  for (const proto of prototypes) {
    const real = (proto as { constructor: new (...a: string[]) => unknown }).constructor;
    // Same name, same prototype, installed where the real one was found — so `f.constructor === Function`,
    // `instanceof`, and `.constructor.name === 'AsyncFunction'` all still hold for host code.
    // A `function` expression, not a method shorthand: a method cannot be called with `new`. Named by
    // the property it is assigned to.
    const replacement = {
      [real.name]: function (...args: string[]): unknown {
        if (forBody()) throw refusal(real.name);
        return construct(real, args, new.target ?? real);
      },
    }[real.name]!;
    defineProp(replacement, 'prototype', { value: proto });
    defineProp(proto, 'constructor', { value: replacement, writable: true, configurable: true, enumerable: false });
    if (real === Function) defineProp(globalThis, 'Function', { value: replacement, writable: true, configurable: true, enumerable: false });
  }
  const builtin = process.getBuiltinModule;
  defineProp(process, 'getBuiltinModule', {
    value: function getBuiltinModule(id: string): unknown {
      if (forBody()) throw refusal('process.getBuiltinModule');
      return apply(builtin, process, [id]);
    },
    writable: true, configurable: true, enumerable: true,
  });
  return { span, hostFiles: [] };
}
