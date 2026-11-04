import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, readlinkSync, realpathSync, statSync } from 'node:fs';

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
  'readdir', 'stat', 'lstat', 'statfs', 'access', 'opendir', 'realpath', 'readlink', 'exists',
  'openAsBlob', 'watch', 'watchFile',
] as const;
const WRITE = [
  'mkdir', 'rmdir', 'rm', 'unlink', 'truncate', 'chmod', 'lchmod', 'chown',
  'lchown', 'utimes', 'lutimes', 'mkdtemp', 'mkdtempDisposable',
] as const;

/** The calls taking an open flag in an options argument, with where it is and what it defaults to. They are
 *  asked about as what the flag does: `readFile(p, { flag: 'w' })` truncates, whatever its name says. */
export const FLAG_OPTION: ReadonlyMap<string, readonly [index: number, flag: string]> = new Map(
  ([['readFile', [1, 'r']], ['writeFile', [2, 'w']], ['appendFile', [2, 'a']]] as const)
    .flatMap(([n, at]) => [[n, at] as const, [`${n}Sync`, at] as const]),
);

/**
 * The function members known to take no path — fd-based calls, `unwatchFile` (which only removes a
 * listener), and the classes a body is handed rather than constructs onto a file. Everything else that is
 * neither in this list nor in the path table is REFUSED: the table is written by hand, and a member node
 * adds later (as it added `mkdtempDisposable` and `Utf8Stream`) would otherwise be a way to a file that is
 * asked about by nobody. A body that needs one finds out at once, with a message naming it.
 */
export const PATHLESS: ReadonlySet<string> = new Set([
  'close', 'fchown', 'fchmod', 'fdatasync', 'fstat', 'fsync', 'ftruncate', 'futimes', 'read', 'readv',
  'write', 'writev', 'unwatchFile',
].flatMap(n => [n, `${n}Sync`]).concat(['Dirent', 'Stats', 'Dir', '_toUnixTimestamp']));

const fixed = (...pairs: (readonly [number, Access])[]): PathArgs => () => pairs;

/** Build `method → path args` for the async surface, then the `*Sync` twins for `fs`. */
export function fsPathArgs(withSync: boolean): Map<string, PathArgs> {
  const m = new Map<string, PathArgs>();
  for (const name of READ)  m.set(name, fixed([0, 'read']));
  for (const name of WRITE) m.set(name, fixed([0, 'write']));
  m.set('copyFile', fixed([0, 'read'], [1, 'write']));
  m.set('cp',       fixed([0, 'read'], [1, 'write']));
  // Both give the source's content a new name, which is asked about as itself — so the source is READ as
  // well (else a file denied for reading in a writable directory is read under the name it was given), and
  // changed: a hard link shares its inode, and a rename removes it.
  m.set('link',     fixed([0, 'read'], [0, 'write'], [1, 'write']));
  m.set('rename',   fixed([0, 'read'], [0, 'write'], [1, 'write']));
  m.set('symlink',  fixed([1, 'write']));                   // the target is not touched; reading through
                                                            // the link is asked about at its real target
  m.set('open',     args => openAccesses(args[1]).map(access => [0, access] as const));
  for (const [name, [index, flag]] of FLAG_OPTION) {
    m.set(name, args => {
      const o = args[index];
      const given = typeof o === 'object' && o !== null ? (o as { flag?: unknown }).flag : undefined;
      return openAccesses(given ?? flag).map(access => [0, access] as const);
    });
  }
  if (withSync) for (const [name, args] of [...m]) m.set(`${name}Sync`, args);
  return m;
}

/**
 * What a flag opens a file to do, which is more than one thing: `r+` hands back a descriptor that both reads
 * and writes, so asking only the write gate would let a grant to write read a file denied for reading. `w` is
 * write alone, since the descriptor cannot read. Anything creating or truncating writes, whatever else it
 * says. Absent (or the callback, in `fs.open(p, cb)`) means node's default, `r`. Anything unrecognised asks
 * both, and node then rejects it.
 */
export function openAccesses(flags: unknown): Access[] {
  if (flags === undefined || flags === null || typeof flags === 'function') return ['read'];
  let reads = true, writes = true;
  if (typeof flags === 'string') {
    reads  = /[r+]/.test(flags);
    writes = /[wa+]/.test(flags);
    if (!reads && !writes) reads = writes = true;
  } else if (typeof flags === 'number') {
    const mode = flags & (constants.O_RDONLY | constants.O_WRONLY | constants.O_RDWR);
    reads  = mode !== constants.O_WRONLY;
    writes = mode !== constants.O_RDONLY || (flags & (constants.O_APPEND | constants.O_CREAT | constants.O_TRUNC)) !== 0;
  }
  return [...(reads ? ['read'] as const : []), ...(writes ? ['write'] as const : [])];
}

/** `glob`/`globSync` take patterns, not paths: each is asked about as a read of the directory it starts
 *  from — its static prefix, resolved against `options.cwd` (else the process cwd). */
export const GLOB = ['glob', 'globSync'] as const;

/** Past this many alternatives a pattern's braces are not expanded, and it is asked about at the root. */
const MAX_BRACE_EXPANSION = 256;

/**
 * The directory each glob pattern starts from: its leading segments up to the first with a glob
 * character, resolved against `cwd`. An absolute pattern ignores `cwd`, as glob itself does.
 *
 * Two things in a pattern reach outside that prefix, so each is accounted for rather than read past:
 * braces, whose alternatives may be paths of their own (`{/etc/*,x}`), are expanded first; and a `..`
 * after a wildcard climbs, so the base climbs once for each — no other segment ascends.
 */
export function globBases(patterns: unknown, cwd: string | undefined): string[] {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const base = cwd ?? process.cwd();
  const bases = list.filter((p): p is string => typeof p === 'string').flatMap(pattern => {
    const expanded = expandBraces(pattern);
    if (expanded === undefined) return [path.parse(path.resolve(base)).root];
    return expanded.map(p => {
      const segs = p.split(/[\\/]/);
      const glob = segs.findIndex(seg => /[*?[\]{}()!]/.test(seg));
      const prefix = (glob === -1 ? segs : segs.slice(0, glob)).join('/');
      let dir = path.resolve(base, prefix === '' && p.startsWith('/') ? '/' : prefix);
      if (glob !== -1) for (const seg of segs.slice(glob)) if (seg === '..') dir = path.dirname(dir);
      return dir;
    });
  });
  return [...new Set(bases)];
}

/** `a{b,c}d` → `abd`, `acd`, recursively; a brace with no top-level comma is literal, as in glob. Undefined
 *  when the alternatives would exceed {@link MAX_BRACE_EXPANSION}. */
function expandBraces(p: string): string[] | undefined {
  let depth = 0, start = -1;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') { if (depth++ === 0) start = i; continue; }
    if (c !== '}' || depth === 0 || --depth !== 0) continue;
    const alternatives = splitTopLevelCommas(p.slice(start + 1, i));
    if (alternatives.length < 2) continue;
    const out: string[] = [];
    for (const alt of alternatives) {
      const more = expandBraces(p.slice(0, start) + alt + p.slice(i + 1));
      if (more === undefined || out.push(...more) > MAX_BRACE_EXPANSION) return undefined;
    }
    return out;
  }
  return [p];
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(from, i)); from = i + 1; }
  }
  parts.push(body.slice(from));
  return parts;
}

export function refusal(message: string): Error {
  return Object.assign(new Error(message), { code: 'EACCES' });
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A path argument reduced, ONCE, to the string that is both asked about and handed to node. Everything but a
 * string can change after it has been read — a `Buffer` or `URL` the body still holds, a getter, a Proxy — so
 * a call never passes the original on (see `prepare` in wrap.ts). `undefined` for what is not a path: an `fd`,
 * a missing optional argument, or anything else node rejects by itself.
 *
 * An object is what node would take for a URL or nothing, and `fileURLToPath` is node's own reading of one: it
 * throws what node would (`ERR_INVALID_URL_SCHEME`, `ERR_INVALID_ARG_TYPE`), so there is no "not a path"
 * outcome to pass through unasked, which a getter answering differently the second time could exploit.
 *
 * Bytes that are not UTF-8 name a file no string can, and decoded lossily they name a different one: the
 * question would be about `\uFFFD` while node opened the real bytes. So they are refused, with no way to ask.
 */
export function toPath(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Uint8Array) {
    try { return utf8.decode(arg); }
    catch { throw refusal('A path that is not valid UTF-8 cannot be asked about, so it is refused. Pass it as a string.'); }
  }
  return typeof arg === 'object' && arg !== null ? fileURLToPath(arg as URL) : undefined;
}

/** More links than this on the way to a file is more than the kernel would follow (`ELOOP`). */
const MAX_LINKS = 40;

/**
 * Resolve `p` to an absolute path with symlinks collapsed, so one file has one subject however it is
 * spelled (`~`-expanded, relative, through a link) and a grant cannot be walked out of: a symlink
 * `src/escape → /etc/shadow` is asked about as `/etc/shadow`. A path that does not exist yet (a file about
 * to be created) has its nearest existing ancestor realpath'd and the rest re-appended, so a write cannot
 * be aimed through a symlinked parent either.
 *
 * A dangling link is the one thing in that walk which "does not exist" and still leads somewhere: `open`
 * with `O_CREAT` follows it and creates its target, so it is followed here too, rather than asked about at
 * the link's own name. A cycle resolves to itself, and the call then fails with `ELOOP`.
 *
 * The native realpath, because it is the one that returns the name as stored: the JS one keeps the case
 * it was given, so on a case-insensitive filesystem (macOS's default) `.ENV` would be a different subject
 * from the `.env` a denial names, and the same file.
 */
export function realResolve(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (let links = 0; links < MAX_LINKS;) {
    try { return path.join(realpathSync.native(cur), ...tail.reverse()); }
    catch { /* not all there */ }
    let target: string | undefined;
    try { target = readlinkSync(cur); } catch { /* not a link */ }
    if (target !== undefined) { cur = path.resolve(path.dirname(cur), target); links++; continue; }
    const parent = path.dirname(cur);
    if (parent === cur) return abs;      // reached the root with nothing existing
    tail.push(path.basename(cur));
    cur = parent;
  }
  return abs;
}

const insensitiveByDevice = new Map<number, boolean>();

/**
 * Whether the volume holding `real` (a {@link realResolve}d path) ignores letter case. Node has no call that
 * says, and the answer is per volume (macOS's default is insensitive, a volume may be formatted otherwise,
 * a mount on Linux may be either), so it is measured: the nearest existing name with a letter in it, looked
 * up again with its case swapped, is the same file exactly when case is ignored. Remembered per device.
 */
export function caseInsensitiveAt(real: string): boolean {
  let cur = real;
  for (;;) {
    const name = path.basename(cur);
    const swapped = [...name].map(c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()).join('');
    if (swapped !== name) {
      try {
        const st = statSync(cur);
        const known = insensitiveByDevice.get(st.dev);
        if (known !== undefined) return known;
        let same = false;
        try { const other = statSync(path.join(path.dirname(cur), swapped)); same = other.dev === st.dev && other.ino === st.ino; }
        catch { /* no such name: case matters here */ }
        insensitiveByDevice.set(st.dev, same);
        return same;
      } catch { /* `cur` does not exist yet: try its parent */ }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * The directory a grant for `real` may name: `real` itself when it is a directory (listing it, and
 * everything in it, are then one answer), else the directory holding it. Always with a trailing
 * separator, which no realpath has. That is what makes a directory subject the only kind that covers by
 * prefix (`PermissionRequest.separators`): a file grant stays exact.
 */
export function directoryOf(real: string): string {
  let isDir = false;
  try { isDir = statSync(real).isDirectory(); } catch { /* not there yet: its parent is the directory */ }
  const dir = isDir ? real : path.dirname(real);
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}
