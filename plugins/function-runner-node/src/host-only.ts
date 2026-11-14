import { AsyncLocalStorage } from 'node:async_hooks';

// What a body may not reach however it gets there: the four function constructors, which compile a string
// in the GLOBAL scope — outside the wrapper whose parameters shadow `process` and `globalThis` — and
// `process.getBuiltinModule`, which loads any builtin without the import gate. Shadowing a NAME cannot
// close the first: `console.log.constructor` is a property, not a name, and every function has one. So
// the objects themselves are replaced, process-wide, by ones that refuse when the code calling them is a
// body's, and behave exactly as before for everything else.
//
// "A body's" is decided by the NEAREST code on the stack, skipping builtins and node's own internals:
//   - the body's: refused. Body code is compiled with the filename `BODY_FILE`, so this catches a call
//     made directly, through a builtin such as `map`, or from a `toJSON`, getter or listener that host
//     code invoked long after the body returned;
//   - a real module file's: allowed. That is matbot's own code — a tool the body called — or a package the
//     user granted the body, which is trusted as itself: granting `imapflow` trusts imapflow to compile or
//     patch what it likes, but not the body that imported it, and not anything else installed. A package
//     that EVALUATES what it is given (a template engine) will evaluate the body's strings: granting one
//     grants that;
//   - nothing, or only node's internals: the span decides. A constructor handed straight to a callback
//     (`promise.then(Function)`, a timer) runs with no code of anyone's above it, so each call also runs
//     in an AsyncLocalStorage span that every continuation it schedules inherits, and `hostCall` leaves.
//
// It is not a sandbox. A body shares this process's built-ins, so it can still REWRITE them —
// `Object.prototype`, `JSON`, `Headers.prototype` — and anything that later reads them reads what it
// wrote. A runner that runs bodies in a process of their own is the answer to that, and a different
// runner.

/** The filename body code is compiled under; no real module can have it. */
export const BODY_FILE = 'tool_function';

// Read when this module loads, before any body runs: a body can reassign every one of these, being
// shared built-ins, and the check must not call anything a body could have replaced.
const { apply, construct, defineProperty: defineProp, getOwnPropertyDescriptor: descriptor } = Reflect;
const { isArray } = Array;
const { getPrototypeOf } = Object;
const SPAN_STORE = AsyncLocalStorage.prototype.getStore;
const SPAN_RUN = AsyncLocalStorage.prototype.run;
const SPAN_EXIT = AsyncLocalStorage.prototype.exit;
const { startsWith } = String.prototype;
const fileOf = ((): (c: unknown) => unknown => {
  const prepare = descriptor(Error, 'prepareStackTrace');
  defineProp(Error, 'prepareStackTrace', { value: (_: unknown, s: unknown[]) => s, writable: true, configurable: true });
  const sites = new Error().stack as unknown as object[];
  restore('prepareStackTrace', prepare);
  const { getFileName } = getPrototypeOf(sites[0]) as { getFileName: () => unknown };
  return c => apply(getFileName, c, []);
})();

interface Shared { span: AsyncLocalStorage<true>; ownFiles: string[]; hidden?: WeakMap<object, Set<PropertyKey>> }
// One per process, so a reloaded copy of this module shares the span and the replacements, and adds its
// own file to those whose frames — the check's own — are skipped.
const KEY = Symbol.for('matbot.functionRunner.hostOnly');
const shared: Shared = ((globalThis as Record<symbol, Shared | undefined>)[KEY] ??= install());
const HERE = import.meta.url;
if (!shared.ownFiles.includes(HERE)) shared.ownFiles.push(HERE);

/** Run `fn` as a body: what it calls, and whatever it schedules, is refused the host's code builders. */
export function inBody<T>(fn: () => T): T {
  return apply(SPAN_RUN, shared.span, [true, fn]) as T;
}

/** Run `fn` as host code acting for a body (FunctionRunner.hostCall): it, and what it schedules, is out of
 *  the body's span, so a tool's continuations — which have no code of the body's above them — are its own. */
export function hostCall<T>(fn: () => T): T {
  return apply(SPAN_EXIT, shared.span, [fn]) as T;
}

/**
 * Make `owner[key]` read as `standIn` to a body, and as itself to everyone else: for a value a body could
 * reach by walking an object it was handed, such as a stream prototype's `constructor`, which is node's own
 * class and opens any file unasked. Replacing the value instead would change it for host code as well, and
 * `stream.constructor === fs.ReadStream` is the kind of test a package makes. An accessor, so it is decided at
 * each read, by the same nearest-code rule as the code builders. Assigning it puts a plain value back. Once
 * per process for an owner and key, however many times it is asked for.
 */
export function hideFromBody(owner: object, key: PropertyKey, standIn: unknown): void {
  const hidden = (shared.hidden ??= new WeakMap());
  let keys = hidden.get(owner);
  if (keys === undefined) hidden.set(owner, keys = new Set());
  if (keys.has(key)) return;
  const was = descriptor(owner, key);
  if (was === undefined || !('value' in was) || was.configurable !== true) return;
  keys.add(key);
  const value: unknown = was.value;
  const enumerable = was.enumerable === true;
  defineProp(owner, key, {
    get(): unknown { return forBody() ? standIn : value; },
    set(this: object, v: unknown) { defineProp(this, key, { value: v, writable: true, configurable: true, enumerable }); },
    enumerable, configurable: true,
  });
}

/** Whether the code calling right now is a body's. Fails closed: a stack it cannot read is a body's. */
function forBody(): boolean {
  const sites = stack();
  if (sites === undefined) return true;
  for (let i = 0; i < sites.length; i++) {
    const file = fileOf(sites[i]);
    if (file === BODY_FILE) return true;
    if (typeof file !== 'string' || !isModuleFile(file) || isOwn(file)) continue;
    return false;
  }
  return apply(SPAN_STORE, shared.span, []) === true;
}

// A module's file: a `file:` URL (ESM) or an absolute path (CommonJS). Not a builtin (no file), node's own
// internals (`node:internal/…`, which call back whatever they were handed), or code compiled from a
// string (`<anonymous>`, `evalmachine.<anonymous>`), none of which says whose call this is.
function isModuleFile(file: string): boolean {
  return apply(startsWith, file, ['file:']) === true || apply(startsWith, file, ['/']) === true;
}
function isOwn(file: string): boolean {
  for (let j = 0; j < shared.ownFiles.length; j++) if (file === shared.ownFiles[j]) return true;
  return false;
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
  contain(span);
  return { span, ownFiles: [] };
}

// A failure a body left unhandled — a rejection in a timer it scheduled, a throw in a callback — was the
// whole process's: node's default for an unhandled rejection or an uncaught exception is to exit, taking
// every session with it, and any body can cause one (`setTimeout(async () => { throw 1 })`). So a failure
// raised inside a body's span is logged and goes no further. Node reports both events in the async context
// they came from, so the span decides, with no stack to read — a rejection carrying no stack (`Promise.reject(1)`)
// is told apart as surely as one that does.
//
// Everything else ends the process exactly as before. Listening at all turns node's default off, so a failure
// that is not a body's is handed back to it: a rejection is rethrown, which makes it an uncaught exception, and
// an uncaught exception is rethrown on the next tick with this listener gone, which is node's own crash. When
// something else is listening too (a host's own policy, a test runner), that is left to decide.
function contain(span: AsyncLocalStorage<true>): void {
  const isBody = (): boolean => apply(SPAN_STORE, span, []) === true;
  const report = (what: string, failure: unknown): void => {
    console.error(`[function-runner-node] A function body left ${what} that nothing handled. It was contained, and the process goes on:`, failure);
  };
  const onRejection = (reason: unknown): void => {
    if (isBody()) { report('a rejected promise', reason); return; }
    if (process.listenerCount('unhandledRejection') > 1) return;
    throw reason;
  };
  const onException = (error: unknown): void => {
    if (isBody()) { report('an exception', error); return; }
    if (process.listenerCount('uncaughtException') > 1) return;
    process.off('uncaughtException', onException);
    process.nextTick(() => { throw error; });
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
}
