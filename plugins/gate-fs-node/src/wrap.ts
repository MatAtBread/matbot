import { fsPathArgs, GLOB, toPath } from './paths.js';
import { checkPath, type FsPolicy } from './policy.js';

/**
 * Wrap an `fs`-shaped module in a Proxy that checks the path arguments of every path-taking method against
 * `policy` before the real call runs, and hands every other property (constants, classes, fd-based calls,
 * `Dirent`…) straight through.
 *
 * `kind` picks the surface and the failure shape:
 *   - `'fs'` — `node:fs`: includes the `*Sync` twins, and a refused call THROWS synchronously, which is how
 *     node itself reports a bad argument to a sync or callback `fs` call.
 *   - `'promises'` — `node:fs/promises` and `fs.promises`: no sync twins, and a refused call REJECTS, so a
 *     body's `await fs.readFile(…)` catches it as it would any fs error rather than seeing a sync throw.
 *
 * The check itself is identical and synchronous for both — it is a rule test, so it works inside a
 * `readFileSync` as well as before a `readFile`. What a sync call cannot do is PROMPT; see the plugin note.
 */
export function wrapFsModule<T extends object>(mod: T, policy: FsPolicy, kind: 'fs' | 'promises'): T {
  const withSync = kind === 'fs';
  const pathArgs = fsPathArgs(withSync);
  const globNames = new Set<string>(withSync ? GLOB : GLOB.filter(n => !n.endsWith('Sync')));

  const checkArgs = (args: unknown[], op: string, indices: readonly number[]): void => {
    for (const i of indices) {
      const p = toPath(args[i]);
      if (p !== undefined) checkPath(p, op, policy);
    }
  };
  // glob's base is options.cwd (string) when given, else the process cwd — which the default policy already
  // confines. So only a supplied cwd needs checking.
  const checkGlob = (args: unknown[], op: string): void => {
    const opts = args[1];
    const cwd = typeof opts === 'object' && opts !== null ? (opts as { cwd?: unknown }).cwd : undefined;
    const p = toPath(cwd);
    if (p !== undefined) checkPath(p, op, policy);
  };

  const guard = (fn: (...a: unknown[]) => unknown, check: (args: unknown[]) => void) =>
    kind === 'promises'
      ? async (...args: unknown[]): Promise<unknown> => { check(args); return Reflect.apply(fn, mod, args); }
      : (...args: unknown[]): unknown => { check(args); return Reflect.apply(fn, mod, args); };

  return new Proxy(mod, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') {
        // `node:fs` exposes its promises API here; wrap it with the promises surface.
        if (prop === 'promises' && typeof value === 'object' && value !== null) {
          return wrapFsModule(value as object, policy, 'promises');
        }
        return value;
      }
      const indices = pathArgs.get(prop);
      if (indices !== undefined) return guard(value as (...a: unknown[]) => unknown, args => checkArgs(args, prop, indices));
      if (globNames.has(prop))   return guard(value as (...a: unknown[]) => unknown, args => checkGlob(args, prop));
      return value;
    },
  });
}
