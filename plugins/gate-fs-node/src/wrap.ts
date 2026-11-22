import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { refusalMessage } from '@matatbread/matbot-plugin-api';
import type { ImportCaller } from '@matatbread/matbot-plugin-api';
import type { ImportedModuleWrapper } from '@matatbread/matbot-function-runner-node';
import { FD_CALLS, FLAG_OPTION, fsPathArgs, GLOB, globBases, openAccesses, PATHLESS, realResolve, refusal, toPath, type Access } from './paths.js';
import { admit, admitSync, DENIED, standingDenial, type Decisions, type OpenedFile } from './gate.js';

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
  /** Run once the call is admitted, in the tick it is made: what has to hold of the filesystem as it is then. */
  before?: () => void;
}

/** A descriptor this invocation did not open through the gate. */
function notOpened(fd: number, op: string, who: string): Error {
  return refusal(`fs.${op} of descriptor ${fd}: it was not opened by ${who} through node:fs, so it is not available. ` +
                 'A function may use only the descriptors it opens, and only until it closes them.');
}

/**
 * A stand-in for something of node's a body reaches by walking a prototype rather than by name: `.constructor`
 * of a stream is node's own class, which opens any file unasked. It keeps the name and the `prototype`, so
 * `x instanceof s.constructor` still holds, and refuses to be called or constructed.
 */
function standIn(name: string, prototype: unknown, instead: string): unknown {
  const f = function (): never {
    throw refusal(`${name}, reached through a prototype, is not available to a function body: it is node's own, ` +
                  `and would reach a file without asking. ${instead}`);
  };
  Object.defineProperty(f, 'name', { value: name });
  Object.defineProperty(f, 'prototype', { value: prototype });
  return f;
}

/** The runner's way to hide a property from a body ({@link ImportedModuleWrapper.hideFromBody}). */
export type HideFromBody = NonNullable<ImportedModuleWrapper['hideFromBody']>;

/** The class of `obj` (a stream, a watcher), hidden from bodies on its prototype. Host code is unaffected. */
function hideClassOf(hide: HideFromBody | undefined, proto: object, instead: string): void {
  const cls = (proto as { constructor?: unknown }).constructor;
  if (hide === undefined || typeof cls !== 'function') return;
  hide(proto, 'constructor', standIn(cls.name, proto, instead));
}

/** The metadata a handle's methods change, which `fs-access` decides. */
const HANDLE_ACCESS = ['chmod', 'chown', 'utimes'] as const;
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
type CheckFd = (fd: number) => void;

const STREAMS = {
  ReadStream:  fileStream('r'),
  WriteStream: fileStream('w'),
  Utf8Stream:  (args: readonly unknown[], gatedFs: object, checkFd: CheckFd): Call => {
    const opts = streamOptions(args[0]);
    const given = opts['fd'] ?? opts['dest'];
    if (typeof given === 'number') checkFd(given);
    const target = toPath(given);
    if (target === undefined) return { args: [{ ...opts, fs: opts['fs'] || gatedFs }], checks: [] };
    const { fd: _fd, ...rest } = opts;
    const accesses = opts['flags'] !== undefined ? openAccesses(opts['flags']) : ['write'] as const;
    return { args: [{ ...rest, dest: target, fs: opts['fs'] || gatedFs }], checks: accesses.map(a => [target, a] as const) };
  },
} as const;
type StreamName = keyof typeof STREAMS;

function fileStream(defaultFlags: string) {
  return (args: readonly unknown[], gatedFs: object, checkFd: CheckFd): Call => {
    const opts = streamOptions(args[1]);
    const fd = opts['fd'];
    if (typeof fd === 'number') checkFd(fd);
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
function gatedStream(name: StreamName, st: Decisions, caller: ImportCaller, hide: HideFromBody | undefined): GatedStream {
  let classes = gatedStreams.get(st);
  if (classes === undefined) gatedStreams.set(st, classes = new Map());
  const had = classes.get(name);
  if (had !== undefined) return had;

  const raw = (nodeFs as unknown as Record<string, new (...a: unknown[]) => unknown>)[name]!;
  hideClassOf(hide, raw.prototype as object, `Use fs.${name} or the call that makes one, from the module you imported.`);
  const gatedFs = wrapFsModule(nodeFs, 'fs', st, caller, hide);
  const checkFd: CheckFd = fd => { if (!st.fds.has(fd)) throw notOpened(fd, name, caller.who); };
  const construct = (op: string, args: unknown[], newTarget: object): unknown => {
    const call = STREAMS[name](args, gatedFs, checkFd);
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
 *
 * `hide` is the runner's {@link ImportedModuleWrapper.hideFromBody}. Without it node's own stream and watcher
 * classes, and a file handle's own metadata methods, stay reachable to a body that walks a prototype.
 */
export function wrapFsModule<T extends object>(mod: T, kind: 'fs' | 'promises', st: Decisions, caller: ImportCaller, hide?: HideFromBody): T {
  const withSync = kind === 'fs';
  const pathArgs = fsPathArgs(withSync);
  const globNames = new Set<string>(withSync ? GLOB : GLOB.filter(n => !n.endsWith('Sync')));

  const prepareFor = (prop: string): Prepare | undefined => {
    const fdUse = withSync ? FD_CALLS.get(prop) : undefined;
    if (fdUse !== undefined) {
      return given => {
        const fd = given[0];
        // Not a number: node rejects it, as it would have.
        if (typeof fd !== 'number') return { args: [...given], checks: [] };
        const opened = st.fds.get(fd);
        if (opened === undefined) throw notOpened(fd, prop, caller.who);
        return {
          args:   [...given],
          checks: fdUse === 'access' ? [[opened.real, 'access']] : [],
          ...(fdUse === 'close' ? { before: () => { if (st.fds.get(fd) === opened) st.fds.delete(fd); } } : {}),
        };
      };
    }
    const indices = pathArgs.get(prop);
    if (indices !== undefined) {
      const flagAt = FLAG_OPTION.get(prop)?.[0];
      const renames = prop === 'rename' || prop === 'renameSync';
      return given => {
        const args = [...given];
        if (flagAt !== undefined) args[flagAt] = copied(args[flagAt]);
        const read = new Map<number, string | undefined>();
        const checks: (readonly [string, Access])[] = [];
        for (const [i, access] of indices(args)) {
          if (!read.has(i)) {
            const arg = args[i];
            // A descriptor where a path can go (`readFile(fd)`) is one the body must have opened.
            if (typeof arg === 'number' && !st.fds.has(arg)) throw notOpened(arg, prop, caller.who);
            const p = typeof arg === 'object' && arg !== null && handles.has(arg) ? undefined : toPath(arg);
            read.set(i, p);
            if (p !== undefined) args[i] = p;
          }
          const p = read.get(i);
          if (p !== undefined) checks.push([p, access]);
        }
        const from = read.get(0);
        return { args, checks, ...(renames && from !== undefined ? { before: () => refuseDeniedBeneath(from, prop) } : {}) };
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
   * A rename moves everything below its source, and an answer names a path, so a denial of something inside
   * would no longer name it. Refused when anything inside is under a standing denial of any of the three gates,
   * saying which and why. Undecided paths do not hold it up, so no rename asks about every file. A link is
   * moved and not what it points at, so the walk does not follow one. Read in the tick of the call, with the
   * filesystem as the rename will find it.
   */
  const refuseDeniedBeneath = (arg: string, op: string): void => {
    let isDir = false;
    try { isDir = nodeFs.lstatSync(path.resolve(arg)).isDirectory(); } catch { /* not there: the rename reports it */ }
    if (!isDir) return;
    const pending = [realResolve(arg)];
    for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
      let entries: nodeFs.Dirent[];
      try { entries = nodeFs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const p = path.join(dir, entry.name);
        for (const access of ['read', 'write', 'access'] as const) {
          const denied = standingDenial(st, caller, access, op, p);
          if (denied !== undefined) {
            throw refusal(refusalMessage(denied,
              `fs.${op} of "${arg}" would move "${p}", ${DENIED[access]}, out from under that answer`));
          }
        }
        if (entry.isDirectory()) pending.push(p);
      }
    }
  };

  /** A descriptor the body now holds, so it may use it, recorded with the file it was opened on. */
  const opened = (fd: unknown, call: Call): OpenedFile | undefined => {
    if (typeof fd !== 'number') return undefined;
    const entry: OpenedFile = { real: realResolve(call.checks[0]?.[0] ?? '') };
    st.fds.set(fd, entry);
    return entry;
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
      if (call.checks.every(([p], i) => realResolve(p) === answered[i])) { call.before?.(); return act(); }
    }
    throw refusal(`fs.${op} of "${call.checks[0]?.[0]}": where this path leads keeps changing, so it cannot be asked about.`);
  };

  /**
   * A handle's own stream methods are the classes by another name, so they make the gated ones. Its descriptor
   * is the body's until the handle closes. The methods that change metadata ask `fs-access` about the file it was
   * opened on, and the prototype's own versions of them are hidden from bodies, since they work on a handle
   * opened only for reading.
   */
  const handedOut = (h: nodeFs.promises.FileHandle, call: Call): object => {
    handles.add(h);
    const fd = h.fd;
    const entry = opened(fd, call)!;
    // A FileHandle is an EventEmitter that says when it closes, which its type declarations leave out.
    (h as unknown as NodeJS.EventEmitter).once('close', () => { if (st.fds.get(fd) === entry) st.fds.delete(fd); });
    const made = (name: StreamName, op: string) => (o?: object) =>
      gatedStream(name, st, caller, hide).make(op, [undefined, { ...o, fd: h }]);
    const proto = Object.getPrototypeOf(h) as Record<string, (...a: unknown[]) => unknown>;
    const metadata = Object.fromEntries(HANDLE_ACCESS.map(m => {
      const own = proto[m]!;
      hide?.(proto, m, standIn(`FileHandle.${m}`, undefined, `Call handle.${m}(…) on the handle, which asks.`));
      return [m, { value: async (...a: unknown[]): Promise<unknown> => {
        await admit(st, caller, 'access', `FileHandle.${m}`, entry.real);
        return Reflect.apply(own, h, a);
      } }];
    }));
    Object.defineProperties(h, {
      createReadStream:  { value: made('ReadStream', 'createReadStream') },
      createWriteStream: { value: made('WriteStream', 'createWriteStream') },
      ...metadata,
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
        return op === 'open' ? handedOut(result as nodeFs.promises.FileHandle, call) : result;
      };
    }
    const callSync = (args: unknown[]): unknown => {
      const call = prepare(args);
      for (const [p, access] of call.checks) admitSync(st, caller, access, op, p);
      call.before?.();
      const result = Reflect.apply(fn, mod, call.args);
      if (op === 'openSync') opened(result, call);
      // A watcher's class makes a watcher of anything, asking nobody; the one handed back is already watching.
      if (op === 'watch' || op === 'watchFile') hideClassOf(hide, Object.getPrototypeOf(result) as object, `Use fs.${op}, which asks.`);
      return result;
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
      if (op === 'open') {
        // The descriptor it calls back with is the body's from then on.
        const done = cb as (e: unknown, fd?: unknown) => void;
        call.args[call.args.length - 1] = (e: unknown, fd?: unknown) => { if (e == null) opened(fd, call); done(e, fd); };
      }
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
        if (prop === 'promises') return wrapFsModule(value as object, 'promises', st, caller, hide);
        // A module namespace's CommonJS view: the whole module again, and the spelling
        // `(await import('node:fs')).default` reaches for by habit.
        if (prop === 'default') return wrapFsModule(value as object, kind, st, caller, hide);
      }
      return value;
    }
    if (withSync) {
      const cls = STREAM_NAMES.get(prop);
      if (cls !== undefined) return gatedStream(cls, st, caller, hide).cls;
      const opens = STREAM_CALLS.get(prop);
      if (opens !== undefined) return (...args: unknown[]) => gatedStream(opens, st, caller, hide).make(prop, args);
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
