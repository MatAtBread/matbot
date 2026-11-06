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

import { readFile, writeFile, copyFile, mkdtemp, rm, mkdir, symlink, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { hostOwnPackageDir } from './remote-cache.js';

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

/**
 * The manifest the registry npm is configured for (the project's `.npmrc` included) would install for a bare
 * `name` — its latest version — read without installing anything. npm whatever the project's package
 * manager, because every one of them reads the same registry configuration and only npm's answer is plain
 * JSON on stdout; stderr is kept apart, where npm writes its notices.
 */
export function registryManifest(name: string, cwd: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const out: string[] = [], err: string[] = [];
    const child = spawn('npm', ['view', name, '--json'], { cwd, shell: process.platform === 'win32' });
    child.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => err.push(d.toString()));
    child.on('error', reject);
    child.on('close', code => {
      let body: unknown;
      try { body = JSON.parse(out.join('')); } catch { body = undefined; }
      const error = (body as { error?: { code?: unknown; summary?: unknown } } | undefined)?.error;
      if (code !== 0 || error !== undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        reject(new Error(error?.code === 'E404'
          ? `there is no package "${name}" in the registry npm is configured for`
          : `npm could not read "${name}" from the registry: ${typeof error?.summary === 'string' ? error.summary : (err.join('') || out.join('')).trim() || `exit code ${String(code)}`}`));
        return;
      }
      resolve(body as Record<string, unknown>);
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
  /** Whether planning wrote the lockfile, which was not there before — so a declined plan can leave no trace. */
  createdLockfile: boolean;
  /** Whether the directory already had node_modules, which installing replaces — so a removal knows if it was ours. */
  hadNodeModules: boolean;
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
  const hadNodeModules = await exists(path.join(dir, 'node_modules'));
  const empty = { dir, packages: [], unsupported: [], createdLockfile: false, hadNodeModules };

  const entries = await declaredRanges(dir);
  if (entries.length === 0) return empty;

  const unsupported = entries.filter(([, range]) => !isRegistryRange(range)).map(([name, range]) => ({ name, range }));
  const hadLockfile = await exists(path.join(dir, LOCKFILE));
  if (unsupported.length > 0) return { dir, packages: [], unsupported, createdLockfile: false, hadNodeModules };

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

  return { dir, packages, unsupported, createdLockfile: !hadLockfile, hadNodeModules };
}

/**
 * Install exactly what the plan listed, then link the host singletons.
 *
 * `npm ci` is deliberate: it installs the lockfile the plan was read from, so what is approved is what
 * lands. It also DELETES node_modules first, which is why the links come after — a link written before
 * would simply be gone.
 *
 * The links are NOT conditional on there being something to install. They were, behind an early return,
 * which meant the simplest plugin there is — one whose only dependency is the peer singleton — got no
 * node_modules and no link at all, and resolved `@matatbread/matbot-plugin-api` by whatever happened to
 * sit above it on disk. Whether an unrelated third-party dependency is present cannot be what decides
 * if the host's singleton is reachable.
 */
export async function applyProvision(plan: ProvisionPlan): Promise<{ linked: readonly string[]; output: string }> {
  const output = plan.packages.length > 0 ? await runCommand('npm', ['ci', ...NPM_FLAGS], plan.dir) : '';
  return { linked: await linkHostSingletons(plan.dir), output };
}

/**
 * Point `<dir>/node_modules/<singleton>` at the copy the HOST loaded, replacing anything that leads
 * elsewhere.
 *
 * `hostOwnPackageDir`, never `hostPackageDirFrom(name, dir)`: that chain tries `dir` first and so answers
 * "what would a plugin here get" — which, when the author has a devDependency copy installed beside their
 * source, is that copy. Linking it to itself is not the question being asked. (It went unnoticed because
 * the old "already exists, first writer wins" test skipped exactly the case that would have exposed it.)
 *
 * A path that already leads to the host's copy is left alone; anything else is replaced, because "there is
 * something here" was never the property worth having — "it resolves to the host's copy" is, and a second
 * physical copy of a singleton is precisely what this exists to prevent. That is also what `npm ci` does
 * on the path where it runs at all: it deletes node_modules and the link is written onto empty ground, so
 * this only makes the two paths agree. An author who reinstalls their devDependencies afterwards gets
 * their copy back and `plugin list` reports it, which is the documented, survivable state.
 */
async function linkHostSingletons(dir: string): Promise<readonly string[]> {
  const linked: string[] = [];
  for (const name of HOST_SINGLETONS) {
    const target = hostOwnPackageDir(name);
    if (target === undefined) continue;                    // not present on this host — nothing to link
    const linkPath = path.join(dir, 'node_modules', name);
    if (await sameDir(linkPath, target)) continue;          // already the host's copy
    await mkdir(path.dirname(linkPath), { recursive: true });
    // `symlink` succeeds against a nonexistent target, so an existing link proves nothing about where it
    // leads; remove first rather than trust it.
    await rm(linkPath, { recursive: true, force: true });
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    linked.push(name);
  }
  return linked;
}

/** Whether `linkPath` resolves to the same real directory as `target`. */
async function sameDir(linkPath: string, target: string): Promise<boolean> {
  try { return await realpath(linkPath) === await realpath(target); } catch { return false; }
}

/**
 * Plan a FETCHED plugin's declared dependencies before any of its code is on disk, so they are listed in the
 * approval for the plugin itself rather than offered after a load that was always going to fail. Planned in
 * a scratch directory holding only the manifest — the one npm will read once the plugin is materialised:
 * the mirrored copy if there is one (a mirrored file is never overwritten), else `pkg`. Undefined when every
 * declared dependency already resolves from where the plugin will run — what an earlier install put in its
 * cache directory survives a refresh, so only a dependency the cached copy never had is offered again.
 */
export async function planRemoteProvision(pkg: Record<string, unknown>, pkgRoot: string): Promise<ProvisionPlan | undefined> {
  const mirrored = await readFile(path.join(pkgRoot, 'package.json'), 'utf8').catch(() => undefined);
  const manifest = mirrored ?? JSON.stringify(pkg, null, 2);
  const deps = (JSON.parse(manifest) as { dependencies?: unknown }).dependencies;
  const declared = deps !== null && typeof deps === 'object' ? Object.keys(deps) : [];
  const unmet: string[] = [];
  for (const name of declared) {
    if (!HOST_SINGLETONS.includes(name) && !await reachable(name, pkgRoot)) unmet.push(name);
  }
  if (unmet.length === 0) return undefined;

  const dir = await mkdtemp(path.join(tmpdir(), 'matbot-plan-'));
  try {
    await writeFile(path.join(dir, 'package.json'), manifest);
    return await planProvision(dir);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Install a `planRemoteProvision` plan into the materialised plugin's cache directory: exactly the lockfile
 *  that was approved, then the host singletons linked. The scratch directory goes either way. */
export async function applyRemoteProvision(plan: ProvisionPlan, pkgRoot: string): Promise<{ linked: readonly string[]; output: string }> {
  try {
    await copyFile(path.join(plan.dir, LOCKFILE), path.join(pkgRoot, LOCKFILE));
    return await applyProvision({ ...plan, dir: pkgRoot });
  } finally {
    await discardRemoteProvision(plan);
  }
}

export async function discardRemoteProvision(plan: ProvisionPlan): Promise<void> {
  await rm(plan.dir, { recursive: true, force: true });
}

/** Undo what planning wrote. A declined install must not leave a lockfile in someone's plugin. */
export async function discardProvision(plan: ProvisionPlan): Promise<void> {
  if (plan.createdLockfile) await rm(path.join(plan.dir, LOCKFILE), { force: true });
}

// Take back what an applied plan created, and only that: a lockfile or a node_modules the directory had
// before is the author's. (`npm ci` replaced a node_modules that was there, so "had one" is all that can be
// known — whatever was in it is not recoverable, and is not deleted either.)
export async function removeProvisioned(created: { dir: string; lockfile: boolean; nodeModules: boolean }): Promise<string[]> {
  const removed: string[] = [];
  if (created.nodeModules) { await rm(path.join(created.dir, 'node_modules'), { recursive: true, force: true }); removed.push('node_modules'); }
  if (created.lockfile)    { await rm(path.join(created.dir, LOCKFILE), { force: true }); removed.push(LOCKFILE); }
  return removed;
}

async function declaredRanges(dir: string): Promise<[string, string][]> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { dependencies?: unknown };
    const d = pkg.dependencies;
    if (d === null || typeof d !== 'object') return [];
    return Object.entries(d as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string');
  } catch {
    return [];   // no manifest, or unreadable — not ours to fix here
  }
}

/**
 * Whether installing a LOCAL plugin's dependencies is matbot's to do: `provision` when the directory is empty
 * ground, `ready` when the author's own install already has every one, otherwise the reason to give them.
 *
 * Empty ground means no `node_modules` and no lockfile, because `npm ci` deletes a `node_modules` before it
 * installs and `--package-lock-only` rewrites a lockfile — neither is matbot's to replace in someone's
 * plugin, and what provisioning creates on empty ground is exactly what it can take back. A manifest with a
 * range that is not a registry one goes to `planProvision` regardless, which leaves it alone.
 */
export async function localProvision(dir: string): Promise<{ provision: boolean } | { refuse: string }> {
  const entries = await declaredRanges(dir);
  if (entries.length === 0 || entries.some(([, range]) => !isRegistryRange(range))) return { provision: entries.length > 0 };

  if (await exists(path.join(dir, 'node_modules'))) {
    // Found where Node will find it, an enclosing node_modules included: a workspace member's dependencies
    // are hoisted to its root, and which copy that is was the author's install's decision.
    const missing: string[] = [];
    for (const [name] of entries) {
      if (!await reachable(name, dir)) missing.push(name);
    }
    if (missing.length === 0) return { provision: false };
    return { refuse:
      `its node_modules does not have ${missing.join(', ')}. Its install is the author's, so install its ` +
      `dependencies in "${dir}" (\`npm install --omit=peer\` — peers are the host's), then add it again` };
  }
  if (await exists(path.join(dir, LOCKFILE))) {
    return { refuse:
      `it has a ${LOCKFILE} but no node_modules. Install from that lockfile in "${dir}" ` +
      `(\`npm ci --omit=peer\` — peers are the host's), then add it again` };
  }
  return { provision: true };
}

async function reachable(name: string, from: string): Promise<boolean> {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, 'node_modules', name, 'package.json'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
