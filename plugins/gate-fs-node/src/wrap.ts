import type { ImportCaller } from '@matatbread/matbot-plugin-api';
import { fsPathArgs, GLOB, globBases, PATHLESS, toPath, type Access } from './paths.js';
import { admit, admitSync, refusal, type Decisions } from './gate.js';

/** `node:fs` members that return synchronously though their names have no `Sync`: they cannot wait for an
 *  answer, so they are treated as synchronous calls. (`watch`'s listener is not a completion callback.) */
const RETURNS_SYNC = new Set(['createReadStream', 'createWriteStream', 'watch', 'watchFile']);

/** `node:fs` members that return a promise though they live on the callback surface. */
const RETURNS_PROMISE = new Set(['openAsBlob']);

/** `node:fs/promises` members that return an async iterator, not a promise: the question is asked before
 *  the first item rather than before the call returns. */
const RETURNS_ITERATOR = new Set(['glob', 'watch']);

/** `node:fs` stream classes, which open their path themselves when constructed — or called, which they
 *  allow without `new` — so they are a way to a file that never passes through `createReadStream`. */
const STREAM_CLASSES = new Map<string, (args: unknown[]) => readonly (readonly [arg: unknown, access: Access])[]>([
  ['ReadStream',      a => [[a[0], 'read']]],
  ['FileReadStream',  a => [[a[0], 'read']]],
  ['WriteStream',     a => [[a[0], 'write']]],
  ['FileWriteStream', a => [[a[0], 'write']]],
  ['Utf8Stream',      a => [[typeof a[0] === 'object' && a[0] !== null ? (a[0] as { dest?: unknown }).dest : undefined, 'write']]],
]);

type Checks = (args: unknown[]) => readonly (readonly [path: string, access: Access])[];

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
 */
export function wrapFsModule<T extends object>(mod: T, kind: 'fs' | 'promises', st: Decisions, caller: ImportCaller): T {
  const withSync = kind === 'fs';
  const pathArgs = fsPathArgs(withSync);
  const globNames = new Set<string>(withSync ? GLOB : GLOB.filter(n => !n.endsWith('Sync')));

  const checksFor = (prop: string): Checks | undefined => {
    const streamArgs = withSync ? STREAM_CLASSES.get(prop) : undefined;
    if (streamArgs !== undefined) {
      return args => streamArgs(args).flatMap(([arg, access]) => {
        const p = toPath(arg);
        return p !== undefined ? [[p, access] as const] : [];
      });
    }
    const indices = pathArgs.get(prop);
    if (indices !== undefined) {
      return args => indices(args).flatMap(([i, access]) => {
        const p = toPath(args[i]);
        return p !== undefined ? [[p, access] as const] : [];
      });
    }
    if (globNames.has(prop)) {
      return args => {
        const opts = args[1];
        const cwd = toPath(typeof opts === 'object' && opts !== null ? (opts as { cwd?: unknown }).cwd : undefined);
        return globBases(args[0], cwd).map(base => [base, 'read'] as const);
      };
    }
    return undefined;
  };

  // Each path in turn, so a two-path call asks its questions one at a time.
  const admitAll = async (checks: readonly (readonly [string, Access])[], op: string): Promise<void> => {
    for (const [p, access] of checks) await admit(st, caller, access, op, p);
  };

  const guard = (fn: (...a: unknown[]) => unknown, op: string, checks: Checks) => {
    if (withSync && STREAM_CLASSES.has(op)) {
      const check = (args: unknown[]) => { for (const [p, access] of checks(args)) admitSync(st, caller, access, op, p); };
      return new Proxy(fn, {
        apply(target, thisArg, args) { check(args); return Reflect.apply(target, thisArg, args); },
        construct(target, args, newTarget) { check(args); return Reflect.construct(target, args, newTarget); },
      });
    }
    if (kind === 'promises' && RETURNS_ITERATOR.has(op)) {
      return async function* (...args: unknown[]): AsyncGenerator<unknown> {
        await admitAll(checks(args), op);
        yield* Reflect.apply(fn, mod, args) as AsyncIterable<unknown>;
      };
    }
    if (kind === 'promises' || RETURNS_PROMISE.has(op)) {
      return async (...args: unknown[]): Promise<unknown> => {
        await admitAll(checks(args), op);
        return Reflect.apply(fn, mod, args);
      };
    }
    if (op.endsWith('Sync') || RETURNS_SYNC.has(op)) {
      return (...args: unknown[]): unknown => {
        for (const [p, access] of checks(args)) admitSync(st, caller, access, op, p);
        return Reflect.apply(fn, mod, args);
      };
    }
    return (...args: unknown[]): unknown => {
      const cb = args[args.length - 1];
      // No completion callback: node rejects the call itself, so let it, after the synchronous check.
      if (typeof cb !== 'function') {
        for (const [p, access] of checks(args)) admitSync(st, caller, access, op, p);
        return Reflect.apply(fn, mod, args);
      }
      // `exists` answers with a boolean, not an error, so a refusal reads as absent rather than present.
      const fail = (e: unknown) => { (cb as (e: unknown) => void)(op === 'exists' ? false : e); };
      admitAll(checks(args), op).then(
        () => {
          // Node throws a bad argument synchronously, which here is inside a `.then` the caller never
          // sees: uncaught, it is an unhandled rejection that takes the process down. The callback is
          // the one place the caller is listening.
          try { Reflect.apply(fn, mod, args); } catch (e) { fail(e); }
        },
        fail,
      );
      return undefined;
    };
  };

  return new Proxy(mod, {
    get(target, prop, receiver) {
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
      const checks = checksFor(prop);
      if (checks !== undefined) return guard(value as (...a: unknown[]) => unknown, prop, checks);
      if (PATHLESS.has(prop)) return value;
      const unknown = (): never => {
        throw refusal(`fs.${prop} is not available to ${caller.who}: whether it reaches a path is not known, so ` +
                      'nothing would ask about it. Use another fs call.');
      };
      return kind === 'promises' ? async () => unknown() : unknown;
    },
  });
}
