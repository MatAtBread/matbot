import type { ImportCaller } from '@matatbread/matbot-plugin-api';
import { fsPathArgs, GLOB, globBases, toPath, type Access } from './paths.js';
import { admit, admitSync, type Decisions } from './gate.js';

/** `node:fs` members that return synchronously though their names have no `Sync`: they cannot wait for an
 *  answer, so they are treated as synchronous calls. (`watch`'s listener is not a completion callback.) */
const RETURNS_SYNC = new Set(['createReadStream', 'createWriteStream', 'watch', 'watchFile']);

/** `node:fs` members that return a promise though they live on the callback surface. */
const RETURNS_PROMISE = new Set(['openAsBlob']);

type Checks = (args: unknown[]) => readonly (readonly [path: string, access: Access])[];

/**
 * Wrap an `fs`-shaped module in a Proxy that puts each path a call names to the gate before the real call
 * runs, and hands every other property (constants, classes, fd-based calls, `Dirent`…) straight through.
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
      admitAll(checks(args), op).then(
        () => { Reflect.apply(fn, mod, args); },
        // `exists` answers with a boolean, not an error, so a refusal reads as absent rather than present.
        (e: unknown) => { (cb as (e: unknown) => void)(op === 'exists' ? false : e); },
      );
      return undefined;
    };
  };

  return new Proxy(mod, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') {
        // `node:fs` exposes its promises API here; wrap it with the promises surface, sharing this
        // invocation's answers.
        if (prop === 'promises' && typeof value === 'object' && value !== null) {
          return wrapFsModule(value as object, 'promises', st, caller);
        }
        return value;
      }
      const checks = checksFor(prop);
      return checks !== undefined ? guard(value as (...a: unknown[]) => unknown, prop, checks) : value;
    },
  });
}
