import * as path from 'node:path';
import { realResolve } from './paths.js';

/**
 * Whether a resolved path is allowed, and if not, why — a short reason the thrown error carries, since a
 * body that over-reaches should be told plainly rather than see an opaque EACCES.
 *
 * The policy is RULE-based, not a prompt: the wrapper runs at module-materialisation time and in the
 * body's own (often synchronous) call stack, which has no gate channel and, for a sync call, could not
 * await one anyway (see the plugin's note). So it enforces what an installation configured, the way
 * `permittedImports` does for modules.
 *
 * Two layers, deny first:
 *   - the DENY set is always applied, relative to `projectDir`: the `.env` vault and the `.data` /
 *     `.plugins` / `.git` / `node_modules` trees are runtime state and secrets, never a body's to read,
 *     and this is the exact class `read_matbot_source` and `Source__grep` reached;
 *   - the ALLOW set bounds the rest. Configured (`permit_fs_paths`) ⇒ only those roots; absent ⇒ the
 *     project tree. So the default confines a body to the source it was given, minus the secrets within it.
 */
export interface FsPolicy {
  readonly projectDir: string | undefined;
  readonly allow: readonly string[];   // realpath'd roots; empty ⇒ default to the project tree
}

const SENSITIVE_DIRS = new Set(['.data', '.plugins', '.git', 'node_modules']);
const ENV_FILE = /^\.env($|\.)/;        // .env, .env.local, … directly under the project root

function underOrEqual(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

export function pathAllowed(real: string, policy: FsPolicy): string | undefined {
  const { projectDir, allow } = policy;

  if (projectDir !== undefined) {
    const rel = path.relative(projectDir, real);
    const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (inside) {
      const seg = rel.split(path.sep);
      if (seg[0] !== undefined && SENSITIVE_DIRS.has(seg[0]))
        return `"${seg[0]}" is runtime state, not a body's to read`;
      if (seg.length === 1 && seg[0] !== undefined && ENV_FILE.test(seg[0]))
        return 'the secrets vault is not a body\'s to read';
    }
  }

  if (allow.length > 0) {
    return allow.some(root => underOrEqual(real, root)) ? undefined
      : 'outside the permitted paths (permit_fs_paths)';
  }
  if (projectDir === undefined) return undefined;   // nothing to confine to; the guard adds only the deny set
  return underOrEqual(real, projectDir) ? undefined : 'outside the project directory';
}

/** Check a raw path argument, throwing a tagged error when the policy refuses it. Returns the argument
 *  unchanged, so a wrapper can `check(args[i])` inline. `realResolve` collapses symlinks first. */
export function checkPath(arg: string, op: string, policy: FsPolicy): void {
  const real = realResolve(arg);
  const why = pathAllowed(real, policy);
  if (why !== undefined) {
    throw Object.assign(
      new Error(`fs.${op}: access to "${arg}" refused — ${why}. Permitted paths are set by the gate-fs-node plugin (permit_fs_paths).`),
      { code: 'EACCES' },
    );
  }
}
