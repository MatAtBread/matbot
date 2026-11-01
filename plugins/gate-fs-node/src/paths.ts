import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

/**
 * The method → path-argument-index map for `node:fs`. Typed per method rather than inferred from the
 * arguments, deliberately: "looks like a path" cannot tell a path from an `fd` (a number), an encoding
 * (`'utf8'` as a second arg), or a flags string, and a wrong guess is worse than none. The sync variants
 * share the async names with a `Sync` suffix, so the table is written once and expanded.
 *
 * fd-based calls (`read`, `write`, `fstat`, `fchmod`, …) take no path — the `open` that produced the fd
 * was already checked, so the fd is a capability the body legitimately holds.
 */
const SINGLE_PATH = [
  'readFile', 'writeFile', 'appendFile', 'readdir', 'stat', 'lstat', 'statfs', 'access', 'open',
  'opendir', 'mkdir', 'rmdir', 'rm', 'unlink', 'truncate', 'realpath', 'readlink', 'chmod', 'lchmod',
  'chown', 'lchown', 'utimes', 'lutimes', 'exists', 'openAsBlob', 'createReadStream', 'createWriteStream',
  'watch', 'watchFile', 'unwatchFile', 'mkdtemp',
] as const;
const TWO_PATH = ['rename', 'copyFile', 'cp', 'link'] as const;    // args 0 and 1 are both paths
const SECOND_PATH = ['symlink'] as const;                           // arg 1 is the path created

/** Build `method → path arg indices` for the async surface, then the `*Sync` twins for `fs`. */
export function fsPathArgs(withSync: boolean): Map<string, readonly number[]> {
  const m = new Map<string, readonly number[]>();
  for (const name of SINGLE_PATH) m.set(name, [0]);
  for (const name of TWO_PATH)    m.set(name, [0, 1]);
  for (const name of SECOND_PATH) m.set(name, [1]);
  if (withSync) for (const [name, idx] of [...m]) m.set(`${name}Sync`, idx);
  return m;
}

/** `glob`/`globSync` take a pattern, not a path; their base is `options.cwd` (else the process cwd). The
 *  caller checks that base when present. Listed apart so the wrapper treats their path as `options.cwd`. */
export const GLOB = ['glob', 'globSync'] as const;

/** A path argument reduced to a filesystem string, or `undefined` for anything that is not a path (an
 *  `fd`, a FileHandle, a missing optional arg). `node:fs` accepts a string, a `Buffer` or a `file:` URL. */
export function toPath(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.protocol === 'file:' ? fileURLToPath(arg) : undefined;
  if (ArrayBuffer.isView(arg) && 'toString' in arg) return (arg as Buffer).toString();
  return undefined;
}

/**
 * Resolve `p` to an absolute path with symlinks collapsed — the check must run on the real target, or a
 * symlink `.data/escape → /etc/shadow` walks straight past a prefix test. A path that does not exist yet
 * (a file about to be created) has its nearest existing ancestor realpath'd and the rest re-appended, so
 * a write cannot be aimed through a symlinked parent either.
 */
export function realResolve(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try { return path.join(realpathSync(cur), ...tail.reverse()); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;      // reached the root with nothing existing
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}
