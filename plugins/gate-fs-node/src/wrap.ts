import * as nodeFs from 'node:fs';
import type { ImportCaller } from '@matatbread/matbot-plugin-api';
import { FLAG_OPTION, fsPathArgs, GLOB, globBases, openAccesses, PATHLESS, realResolve, refusal, toPath, type Access } from './paths.js';
import { admit, admitSync, type Decisions } from './gate.js';

/** `node:fs` members that return synchronously though their names have no `Sync`: they cannot wait for an
 *  answer, so they are treated as synchronous calls. (`watch`'s listener is not a completion callback.) */
const RETURNS_SYNC = new Set(['watch', 'watchFile']);

/** `node:fs` members that return a promise though they live on the callback surface. */
const RETURNS_PROMISE = new Set(['openAsBlob']);

/** `node:fs/promises` members that return an async iterator, not a promise: the question is asked before
 *  the first item rather than before the call returns. */
const RETURNS_ITERATOR = new Set(['glob', 'watch']);

/** How many times a call is asked about again because a link on the way to its file keeps changing. */
const MAX_ASKS = 4;

/**
 * A call as it will be made: the arguments node is handed, with each path reduced to the string that was
 * asked about, and what to ask. Nothing the body still holds is passed on where it could change what is
 * opened, because the question and the call are apart by a tick at least, and by a human's whole answer at
 * most: a `Buffer` rewritten, a `URL`'s `pathname` assigned, an array of patterns or an options getter
 * answering differently the second time.
 */
interface Call {
  args:   unknown[];
  checks: readonly (readonly [path: string, access: Access])[];
}
type Prepare = (args: readonly unknown[]) => Call;

/** The handles this plugin handed out: the one object that is not a path where a path goes
 *  (`fsp.readFile(handle)`), told apart by identity, since anything a body can spell it can also fake. */
const handles = new WeakSet<object>();

const copied = (o: unknown): unknown => typeof o === 'object' && o !== null ? { ...o } : o;

/** A stream's options as node reads them, read once. */
function streamOptions(o: unknown): Record<string, unknown> {
  if (typeof o === 'string') return { encoding: o };
  return o === undefined || o === null ? {} : { ...o as object };
}

/**
 * The stream classes open their file on a later tick, from properties the body can assign, and `Utf8Stream`
 * reopens on request — so a check of what the constructor was given says nothing about what is opened. All
 * three take the fs they open with as an option, so they are given this invocation's, and every open they
 * ever make is an ordinary guarded call: it asks about the path and flags as they stand when it happens. That
 * also leaves no reference to the raw module on the stream. A body's own `fs` option is its own code, and is
 * left in place; a `FileHandle` as `fd` opens nothing and refuses to be combined with one.
 */
const STREAMS = {
  ReadStream:  fileStream('r'),
  WriteStream: fileStream('w'),
  Utf8Stream:  (args: readonly unknown[], gatedFs: object): Call => {
    const opts = streamOptions(args[0]);
    const target = toPath(opts['fd'] ?? opts['dest']);
    if (target === undefined) return { args: [{ ...opts, fs: opts['fs'] || gatedFs }], checks: [] };
    const { fd: _fd, ...rest } = opts;
    const accesses = opts['flags'] !== undefined ? openAccesses(opts['flags']) : ['write'] as const;
    return { args: [{ ...rest, dest: target, fs: opts['fs'] || gatedFs }], checks: accesses.map(a => [target, a] as const) };
  },
} as const;
type StreamName = keyof typeof STREAMS;

function fileStream(defaultFlags: string) {
  return (args: readonly unknown[], gatedFs: object): Call => {
    const opts = streamOptions(args[1]);
    const fd = opts['fd'];
    if (fd !== undefined && fd !== null) {
      return { args: [undefined, typeof fd === 'object' ? opts : { ...opts, fs: opts['fs'] || gatedFs }], checks: [] };
    }
    const p = toPath(args[0]);
    return {
      args:   [p ?? args[0], { ...opts, fs: opts['fs'] || gatedFs }],
      checks: p === undefined ? [] : openAccesses(opts['flags'] ?? defaultFlags).map(a => [p, a] as const),
    };
  };
}

/** Every name by which `node:fs` offers a stream class. */
const STREAM_NAMES = new Map<string, StreamName>([
  ['ReadStream', 'ReadStream'], ['FileReadStream', 'ReadStream'],
  ['WriteStream', 'WriteStream'], ['FileWriteStream', 'WriteStream'],
  ['Utf8Stream', 'Utf8Stream'],
]);

const STREAM_CALLS = new Map<string, StreamName>([['createReadStream', 'ReadStream'], ['createWriteStream', 'WriteStream']]);

interface GatedStream {
  cls:  new (...args: unknown[]) => unknown;
  make: (op: string, args: unknown[]) => unknown;
}

const gatedStreams = new WeakMap<Decisions, Map<StreamName, GatedStream>>();

/**
 * A stream class for one invocation. One per invocation and per class, so `instanceof` holds across the names
 * a class has and the ways to reach it. Its instances inherit from a prototype whose `constructor` is this,
 * because a stream's `constructor` is a name like any other: left alone, `new s.constructor(path)` is node's
 * own class, asking nobody.
 */
function gatedStream(name: StreamName, st: Decisions, caller: ImportCaller): GatedStream {
  let classes = gatedStreams.get(st);
  if (classes === undefined) gatedStreams.set(st, classes = new Map());
  const had = classes.get(name);
  if (had !== undefined) return had;

  const raw = (nodeFs as unknown as Record<string, new (...a: unknown[]) => unknown>)[name]!;
  const gatedFs = wrapFsModule(nodeFs, 'fs', st, caller);
  const construct = (op: string, args: unknown[], newTarget: object): unknown => {
    const call = STREAMS[name](args, gatedFs);
    for (const [p, access] of call.checks) admitSync(st, caller, access, op, p);
    return Reflect.construct(raw, call.args, newTarget as new (...a: unknown[]) => unknown);
  };
  // Called, too, which these classes allow.
  const Gated = function (this: unknown, ...args: unknown[]): unknown {
    return construct(name, args, new.target ?? Gated);
  } as unknown as GatedStream['cls'];
  Object.defineProperty(Gated, 'name', { value: name, configurable: true });
  Gated.prototype = Object.create(raw.prototype as object, { constructor: { value: Gated, writable: true, configurable: true } }) as object;

  const made: GatedStream = { cls: Gated, make: (op, args) => construct(op, args, Gated) };
  classes.set(name, made);
  return made;
}

/**
 * Wrap an `fs`-shaped module in a Proxy that puts each path a call names to the gate before the real call
 * runs, hands through what is known to take no path (constants, fd-based calls, `Dirent`…), and refuses any
 * other function — one node added since the table was written (see {@link PATHLESS}).
 *
 * How a call is asked depends on whether it can wait:
 *   - a promise (`node:fs/promises`, `fs.promises`, `openAsBlob`) or a completion callback (`fs.readFile(p,
 *     cb)`) can, so it ASKS — a prompt when nothing standing decides — and a refusal rejects or reaches the
 *     callback as an `EACCES` error, as any fs failure would;
 *   - a synchronous call (`readFileSync`, `createReadStream`) cannot, so it consults the answers in force
 *     and THROWS when they do not allow it, saying how to be asked.
 *
 * What it holds against is a body USING the module, with nothing shared changed: see "What it is, and is not"
 * in the README for the deliberate interference it does not.
 */
export function wrapFsModule<T extends object>(mod: T, kind: 'fs' | 'promises', st: Decisions, caller: ImportCaller): T {
  const withSync = kind === 'fs';
  const pathArgs = fsPathArgs(withSync);
  const globNames = new Set<string>(withSync ? GLOB : GLOB.filter(n => !n.endsWith('Sync')));

  const prepareFor = (prop: string): Prepare | undefined => {
    const indices = pathArgs.get(prop);
    if (indices !== undefined) {
      const flagAt = FLAG_OPTION.get(prop)?.[0];
      return given => {
        const args = [...given];
        if (flagAt !== undefined) args[flagAt] = copied(args[flagAt]);
        const read = new Map<number, string | undefined>();
        const checks: (readonly [string, Access])[] = [];
        for (const [i, access] of indices(args)) {
          if (!read.has(i)) {
            const arg = args[i];
            const p = typeof arg === 'object' && arg !== null && handles.has(arg) ? undefined : toPath(arg);
            read.set(i, p);
            if (p !== undefined) args[i] = p;
          }
          const p = read.get(i);
          if (p !== undefined) checks.push([p, access]);
        }
        return { args, checks };
      };
    }
    if (globNames.has(prop)) {
      return given => {
        const patterns = Array.isArray(given[0]) ? [...given[0] as unknown[]] : given[0];
        const opts = copied(given[1]) as { cwd?: unknown } | undefined;
        const cwd = typeof opts === 'object' && opts !== null ? toPath(opts.cwd) : undefined;
        if (cwd !== undefined) opts!.cwd = cwd;
        return { args: [patterns, opts, ...given.slice(2)], checks: globBases(patterns, cwd).map(base => [base, 'read'] as const) };
      };
    }
    return undefined;
  };

  /**
   * Ask each path in turn (so a two-path call asks its questions one at a time), then run `act` in the same
   * tick as the last look at where the paths lead. An answer is about a file, and a symlink on the way to it
   * can be repointed while the question is open — by a body with write access beside it, deterministically,
   * since it runs first. So a call whose path no longer leads where it did is asked about again. The window
   * this leaves is the one between the look and the kernel's own walk of the path, which no path check closes.
   */
  const whenAdmitted = async <R>(call: Call, op: string, act: () => R): Promise<R> => {
    for (let asks = 0; asks < MAX_ASKS; asks++) {
      const answered: string[] = [];
      for (const [p, access] of call.checks) answered.push(await admit(st, caller, access, op, p));
      if (call.checks.every(([p], i) => realResolve(p) === answered[i])) return act();
    }
    throw refusal(`fs.${op} of "${call.checks[0]?.[0]}": where this path leads keeps changing, so it cannot be asked about.`);
  };

  /** A handle's own stream methods are the classes by another name, so they make the gated ones. */
  const handedOut = (h: object): object => {
    handles.add(h);
    const made = (name: StreamName, op: string) => (o?: object) =>
      gatedStream(name, st, caller).make(op, [undefined, { ...o, fd: h }]);
    Object.defineProperties(h, {
      createReadStream:  { value: made('ReadStream', 'createReadStream') },
      createWriteStream: { value: made('WriteStream', 'createWriteStream') },
    });
    return h;
  };

  const guard = (fn: (...a: unknown[]) => unknown, op: string, prepare: Prepare) => {
    if (kind === 'promises' && RETURNS_ITERATOR.has(op)) {
      return async function* (...args: unknown[]): AsyncGenerator<unknown> {
        const call = prepare(args);
        yield* await whenAdmitted(call, op, () => Reflect.apply(fn, mod, call.args) as AsyncIterable<unknown>);
      };
    }
    if (kind === 'promises' || RETURNS_PROMISE.has(op)) {
      return async (...args: unknown[]): Promise<unknown> => {
        const call = prepare(args);
        const result = await whenAdmitted(call, op, () => Reflect.apply(fn, mod, call.args));
        return op === 'open' ? handedOut(result as object) : result;
      };
    }
    const callSync = (args: unknown[]): unknown => {
      const call = prepare(args);
      for (const [p, access] of call.checks) admitSync(st, caller, access, op, p);
      return Reflect.apply(fn, mod, call.args);
    };
    if (op.endsWith('Sync') || RETURNS_SYNC.has(op)) return (...args: unknown[]): unknown => callSync(args);
    return (...args: unknown[]): unknown => {
      const cb = args[args.length - 1];
      // No completion callback: node rejects the call itself, so let it, after the synchronous check.
      if (typeof cb !== 'function') return callSync(args);
      // `exists` answers with a boolean, not an error, so a refusal reads as absent rather than present.
      const fail = (e: unknown) => { (cb as (e: unknown) => void)(op === 'exists' ? false : e); };
      let call: Call;
      // In the caller's tick, or the path would be read after whatever the caller does next. A bad one is
      // reported on a later tick, as a completion callback always is.
      try { call = prepare(args); }
      catch (e) { queueMicrotask(() => fail(e)); return undefined; }
      whenAdmitted(call, op, () => {
        // Node throws a bad argument synchronously, which here is inside a promise the caller never
        // sees: uncaught, it is an unhandled rejection that takes the process down. The callback is
        // the one place the caller is listening.
        try { Reflect.apply(fn, mod, call.args); } catch (e) { fail(e); }
      }).catch(fail);
      return undefined;
    };
  };

  const member = (target: T, prop: string | symbol, receiver: unknown): unknown => {
    const value = Reflect.get(target, prop, receiver);
    if (typeof prop !== 'string' || typeof value !== 'function') {
      if (typeof value === 'object' && value !== null) {
        // `node:fs` exposes its promises API here; wrap it with the promises surface, sharing this
        // invocation's answers.
        if (prop === 'promises') return wrapFsModule(value as object, 'promises', st, caller);
        // A module namespace's CommonJS view: the whole module again, and the spelling
        // `(await import('node:fs')).default` reaches for by habit.
        if (prop === 'default') return wrapFsModule(value as object, kind, st, caller);
      }
      return value;
    }
    if (withSync) {
      const cls = STREAM_NAMES.get(prop);
      if (cls !== undefined) return gatedStream(cls, st, caller).cls;
      const opens = STREAM_CALLS.get(prop);
      if (opens !== undefined) return (...args: unknown[]) => gatedStream(opens, st, caller).make(prop, args);
    }
    const prepare = prepareFor(prop);
    if (prepare !== undefined) return guard(value as (...a: unknown[]) => unknown, prop, prepare);
    if (PATHLESS.has(prop)) return value;
    const unknown = (): never => {
      throw refusal(`fs.${prop} is not available to ${caller.who}: whether it reaches a path is not known, so ` +
                    'nothing would ask about it. Use another fs call.');
    };
    return kind === 'promises' ? async () => unknown() : unknown;
  };

  // The module behind this Proxy is matbot's own, so it can be read only as guarded members and not written
  // through: with no trap, a descriptor hands back the raw function, and an assignment reaches every other
  // caller of `node:fs` in the process.
  const self: T = new Proxy(mod, {
    get: member,
    getOwnPropertyDescriptor(target, prop) {
      const d = Reflect.getOwnPropertyDescriptor(target, prop);
      if (d === undefined) return undefined;
      return { value: member(target, prop, self), writable: d.writable ?? false, enumerable: d.enumerable ?? false, configurable: d.configurable ?? false };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
  return self;
}
