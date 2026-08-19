// Making a local plugin directory's own dependencies resolvable — the local route's missing half.
//
// A local plugin was the one route that resolved NOTHING: its bare imports were whatever happened to be
// installed around it, which is always true in a workspace checkout and rarely true anywhere else. The
// identical plugin loads over http and fails as `./mine`. So "wrap a third-party module in a tool" — a
// first-class use case — did not work locally at all.
//
// The rule is that matbot does not become a package manager. There is a good one already, so this asks
// npm the question and gets out of the way:
//
//   - **npm, unconditionally.** `pnpm install` in a directory inside a workspace walks up, reports
//     "Already up to date", exits 0 and installs NOTHING; with `--ignore-workspace` it then fails on the
//     unpublishable host version. npm stays in the directory it is given (measured: an outer package.json
//     one level up is ignored entirely, and no outer lockfile appears).
//   - **`--omit=peer` is load-bearing, not hygiene.** Without it npm auto-installs the root's peer
//     dependencies, which for a plugin means a SECOND copy of `@matatbread/matbot-plugin-api` fetched
//     from the registry at whatever version is published — measured landing 0.4.4 beside a host running
//     0.4.5. Host singletons are linked, never installed. `--omit=dev` for the same reason in reverse: a
//     plugin being used is not being developed.
//   - **`--ignore-scripts`** on both phases. Installing a plugin's dependencies must not run arbitrary
//     code as a side effect of installing a plugin.
//   - **One approval gate, listing the resolved set.** `--package-lock-only` answers "what would this
//     install, transitives included" without writing a single package to disk; the caller folds that list
//     into the approval it was already asking for, and `npm ci` then installs exactly what was approved.

import { readFile, rm, mkdir, symlink, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { hostPackageDirFrom } from './remote-cache.js';

/** Run a command to completion, resolving its combined output. Lives here because this module is the
 *  package-manager plumbing; the `plugin` tool's own installs use it too. */
export function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.on('close', code => {
      if (code === 0) resolve(chunks.join(''));
      else reject(new Error(`${cmd} exited with code ${String(code)}\n${chunks.join('')}`));
    });
  });
}

// The singletons the host owns. A plugin never gets its own copy: `plugin-api` keeps state on
// `globalThis` and brand-checks its errors, so a duplicate is survivable rather than corrupting — but it
// is still a different module object, and the point of linking is that there is nothing to survive.
const HOST_SINGLETONS = ['@matatbread/matbot-plugin-api', '@matatbread/matbot-core'];

const NPM_FLAGS = ['--ignore-scripts', '--omit=peer', '--omit=dev'];

/**
 * A range npm can resolve from a registry, and nothing else. A `:` is a protocol
 * (`workspace:`, `catalog:`, `link:`, `file:`, `git+ssh:`), a `/` is a URL or a GitHub shorthand, a
 * leading `.` is a path. `npm:` is the exception: an alias is still the registry.
 *
 * A manifest carrying any of the others is left ENTIRELY alone — not partially provisioned. Those
 * protocols say "I am a member of a workspace that already resolves me", which is exactly the sqlite
 * plugin and every other in-repo one; npm cannot parse them, and rewriting someone's manifest to hide
 * them from it would be this module resolving dependencies itself, one indirection from the thing it
 * exists not to do.
 */
export function isRegistryRange(range: string): boolean {
  if (range.startsWith('npm:')) return true;
  return !range.includes(':') && !range.includes('/') && !range.startsWith('.');
}

export interface ProvisionPlan {
  dir: string;
  /** `name@version` for everything npm would install, transitives included. Empty ⇒ nothing to do. */
  packages:    readonly string[];
  /** Declared ranges this route will not hand to a package manager; when non-empty, nothing is installed. */
  unsupported: readonly { name: string; range: string }[];
  /** Whether the directory already had a lockfile, so a declined plan can leave no trace. */
  hadLockfile: boolean;
}

const LOCKFILE = 'package-lock.json';

/**
 * Ask npm what this directory's declared dependencies resolve to, writing only a lockfile — no package
 * is fetched into place, so a plan can be presented for approval and then abandoned.
 *
 * Peer and dev entries are filtered OUT of `packages` although the lockfile records them: `--omit=peer`
 * means they will not be installed, and an approval list must describe what will actually happen.
 */
export async function planProvision(dir: string): Promise<ProvisionPlan> {
  const empty = { dir, packages: [], unsupported: [], hadLockfile: false };

  let deps: Record<string, unknown>;
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { dependencies?: unknown };
    const d = pkg.dependencies;
    if (d === null || typeof d !== 'object') return empty;
    deps = d as Record<string, unknown>;
  } catch {
    return empty;   // no manifest, or unreadable — not ours to fix here
  }

  const entries = Object.entries(deps).filter((e): e is [string, string] => typeof e[1] === 'string');
  if (entries.length === 0) return empty;

  const unsupported = entries.filter(([, range]) => !isRegistryRange(range)).map(([name, range]) => ({ name, range }));
  const hadLockfile = await exists(path.join(dir, LOCKFILE));
  if (unsupported.length > 0) return { dir, packages: [], unsupported, hadLockfile };

  await runCommand('npm', ['install', '--package-lock-only', ...NPM_FLAGS], dir);

  let lock: { packages?: Record<string, { version?: string; peer?: boolean; dev?: boolean; link?: boolean }> };
  try {
    lock = JSON.parse(await readFile(path.join(dir, LOCKFILE), 'utf8')) as typeof lock;
  } catch (e) {
    throw new Error(`npm wrote no readable ${LOCKFILE} in "${dir}": ${e instanceof Error ? e.message : String(e)}`);
  }

  const packages = Object.entries(lock.packages ?? {})
    .filter(([key, v]) => key !== '' && v.peer !== true && v.dev !== true && v.link !== true)
    .map(([key, v]) => `${key.replace(/^(?:.*\/)?node_modules\//, '')}@${v.version ?? '?'}`)
    .sort();

  return { dir, packages, unsupported, hadLockfile };
}

/**
 * Install exactly what the plan listed, then link the host singletons.
 *
 * `npm ci` is deliberate: it installs the lockfile the plan was read from, so what is approved is what
 * lands. It also DELETES node_modules first, which is why the links come after — a link written before
 * would simply be gone.
 */
export async function applyProvision(plan: ProvisionPlan): Promise<{ linked: readonly string[]; output: string }> {
  if (plan.packages.length === 0) return { linked: [], output: '' };

  const output = await runCommand('npm', ['ci', ...NPM_FLAGS], plan.dir);

  const linked: string[] = [];
  for (const name of HOST_SINGLETONS) {
    const target = hostPackageDirFrom(name, plan.dir);
    if (target === undefined) continue;                    // not present on this host — nothing to link
    const linkPath = path.join(plan.dir, 'node_modules', name);
    if (await exists(linkPath)) continue;                   // already resolvable here — first writer wins
    await mkdir(path.dirname(linkPath), { recursive: true });
    try {
      await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return { linked, output };
}

/** Undo what planning wrote. A declined install must not leave a lockfile in someone's plugin. */
export async function discardProvision(plan: ProvisionPlan): Promise<void> {
  if (plan.hadLockfile || plan.packages.length === 0) return;
  await rm(path.join(plan.dir, LOCKFILE), { force: true });
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
