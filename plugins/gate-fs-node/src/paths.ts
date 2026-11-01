import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, realpathSync, statSync } from 'node:fs';

/** Which of the two gates a path argument is put to. A grant to read a path does not let a body change it. */
export type Access = 'read' | 'write';

/** For one call: each path argument's index and the access it needs. */
type PathArgs = (args: readonly unknown[]) => readonly (readonly [index: number, access: Access])[];

/**
 * The method → path-argument map for `node:fs`. Typed per method rather than inferred from the arguments,
 * deliberately: "looks like a path" cannot tell a path from an `fd` (a number), an encoding (`'utf8'` as a
 * second arg), or a flags string, and a wrong guess is worse than none. The sync variants share the async
 * names with a `Sync` suffix, so the table is written once and expanded.
 *
 * fd-based calls (`read`, `write`, `fstat`, `fchmod`, …) take no path — the `open` that produced the fd
 * was already asked about, with the access its flags asked for, so the fd is a capability the body
 * legitimately holds.
 */
const READ = [
  'readFile', 'readdir', 'stat', 'lstat', 'statfs', 'access', 'opendir', 'realpath', 'readlink', 'exists',
  'openAsBlob', 'createReadStream', 'watch', 'watchFile',
] as const;
const WRITE = [
  'writeFile', 'appendFile', 'mkdir', 'rmdir', 'rm', 'unlink', 'truncate', 'chmod', 'lchmod', 'chown',
  'lchown', 'utimes', 'lutimes', 'mkdtemp', 'createWriteStream',
] as const;

const fixed = (...pairs: (readonly [number, Access])[]): PathArgs => () => pairs;

/** Build `method → path args` for the async surface, then the `*Sync` twins for `fs`. */
export function fsPathArgs(withSync: boolean): Map<string, PathArgs> {
  const m = new Map<string, PathArgs>();
  for (const name of READ)  m.set(name, fixed([0, 'read']));
  for (const name of WRITE) m.set(name, fixed([0, 'write']));
  m.set('copyFile', fixed([0, 'read'], [1, 'write']));
  m.set('cp',       fixed([0, 'read'], [1, 'write']));
  m.set('link',     fixed([0, 'read'], [1, 'write']));
  m.set('rename',   fixed([0, 'write'], [1, 'write']));     // the source is removed, so it is changed too
  m.set('symlink',  fixed([1, 'write']));                   // the target is not touched; reading through
                                                            // the link is asked about at its real target
  m.set('open',     args => [[0, openAccess(args[1])]]);
  if (withSync) for (const [name, args] of [...m]) m.set(`${name}Sync`, args);
  return m;
}

/** `open`'s flags, as the access they ask for. Anything unrecognised asks the stricter question. */
export function openAccess(flags: unknown): Access {
  if (flags === undefined || flags === null) return 'read';
  if (typeof flags === 'string') return /[wa+]/.test(flags) ? 'write' : 'read';
  if (typeof flags === 'number') {
    const writes = constants.O_WRONLY | constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_TRUNC;
    return (flags & writes) !== 0 ? 'write' : 'read';
  }
  return 'write';
}

/** `glob`/`globSync` take patterns, not paths: each is asked about as a read of the directory it starts
 *  from — its static prefix, resolved against `options.cwd` (else the process cwd). */
export const GLOB = ['glob', 'globSync'] as const;

/** The directory each glob pattern starts from: its leading segments up to the first with a glob
 *  character, resolved against `cwd`. An absolute pattern ignores `cwd`, as glob itself does. */
export function globBases(patterns: unknown, cwd: string | undefined): string[] {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const base = cwd ?? process.cwd();
  return list.filter((p): p is string => typeof p === 'string').map(p => {
    const segs = p.split(/[\\/]/);
    const fixedSegs: string[] = [];
    for (const seg of segs) {
      if (/[*?[\]{}()!]/.test(seg)) break;
      fixedSegs.push(seg);
    }
    const prefix = fixedSegs.join('/');
    return path.resolve(base, prefix === '' && p.startsWith('/') ? '/' : prefix);
  });
}

/** A path argument reduced to a filesystem string, or `undefined` for anything that is not a path (an
 *  `fd`, a FileHandle, a missing optional arg). `node:fs` accepts a string, a `Buffer` or a `file:` URL. */
export function toPath(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.protocol === 'file:' ? fileURLToPath(arg) : undefined;
  if (ArrayBuffer.isView(arg) && 'toString' in arg) return (arg as Buffer).toString();
  return undefined;
}

/**
 * Resolve `p` to an absolute path with symlinks collapsed, so one file has one subject however it is
 * spelled (`~`-expanded, relative, through a link) and a grant cannot be walked out of: a symlink
 * `src/escape → /etc/shadow` is asked about as `/etc/shadow`. A path that does not exist yet (a file about
 * to be created) has its nearest existing ancestor realpath'd and the rest re-appended, so a write cannot
 * be aimed through a symlinked parent either.
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

/**
 * The directory a grant for `real` may name: `real` itself when it is a directory (listing it, and
 * everything in it, are then one answer), else the directory holding it. Always with a trailing
 * separator, which no realpath has. That is what makes a directory subject the only kind that covers by
 * prefix (`PermissionRequest.prefix`): a file grant stays exact.
 */
export function directoryOf(real: string): string {
  let isDir = false;
  try { isDir = statSync(real).isDirectory(); } catch { /* not there yet: its parent is the directory */ }
  const dir = isDir ? real : path.dirname(real);
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}
