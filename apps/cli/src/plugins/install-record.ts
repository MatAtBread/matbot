// What `plugin add` changed in files that are not matbot's own, recorded at the moment it changed them.
//
// Two kinds of thing a plugin install leaves behind, and they are told apart by who owns them:
//
//   - matbot's own cache — a fetched plugin's mirrored source, the dependencies installed into it, its name
//     link and its set-aside copy. Every one of those is derivable from the config entry, so nothing about
//     them is recorded: `releaseRemote` (remote-cache.ts) finds and removes them.
//   - the project's files, changed on matbot's behalf — a key `npm add` wrote into `package.json`, or the
//     lockfile and node_modules a dependency install wrote into a local plugin's directory. Once there,
//     nothing distinguishes them from what the user put there themselves, and reading `package.json` to
//     guess is how `remove` came to offer to uninstall a project's own peer dependency. So what an install
//     created is written down here as it is created, and `remove` takes back only what is written down.
//
// One file per config entry, under a dot-directory so the cache scan and the module hook never read it as a
// host. Keyed by a hash because an entry is a URL or a path, which is no file name.

import { readFile, writeFile, rm, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export interface InstallRecord {
  entry: string;
  // A dependency key the install added to the project's `package.json`, in no section before it.
  dependency?: string;
  // What installing a local plugin's dependencies created in its directory, where it was not before.
  provisioned?: { dir: string; lockfile: boolean; nodeModules: boolean };
}

const RECORDS = '.installs';

const recordPath = (dotPlugins: string, entry: string): string =>
  path.join(dotPlugins, RECORDS, createHash('sha256').update(entry).digest('hex').slice(0, 32) + '.json');

export async function readInstallRecord(dotPlugins: string, entry: string): Promise<InstallRecord | undefined> {
  try { return JSON.parse(await readFile(recordPath(dotPlugins, entry), 'utf8')) as InstallRecord; }
  catch { return undefined; }
}

export async function writeInstallRecord(dotPlugins: string, record: InstallRecord): Promise<void> {
  if (record.dependency === undefined && record.provisioned === undefined) return;
  const p = recordPath(dotPlugins, record.entry);
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
  await rename(tmp, p);
}

export async function dropInstallRecord(dotPlugins: string, entry: string): Promise<void> {
  await rm(recordPath(dotPlugins, entry), { force: true });
}

// EVERY section, because a package manager treats a name declared in any of them as already present —
// npm moves an existing `devDependencies` entry into `dependencies`, pnpm leaves it where it is — and an
// install of a name the project already had did not introduce it. Undefined when there is no manifest:
// the install then lands in whichever ancestor has one, which was never read, so nothing can be claimed.
const SECTIONS = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'] as const;

export async function declaredDependencies(projectDir: string): Promise<Set<string> | undefined> {
  try {
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8')) as
      Partial<Record<typeof SECTIONS[number], Record<string, string>>>;
    return new Set(SECTIONS.flatMap(section => Object.keys(pkg[section] ?? {})));
  } catch {
    return undefined;
  }
}

// An install records a dependency only when it was handed a bare package name — the key a package manager
// writes is then that name, so "declared now and not before" is an observation, not an inference. A version,
// a tarball or a git URL is refused before anything is installed, by both `plugin add` and `matbot install`.
export const isPackageName = (s: string): boolean => /^(?:@[a-z0-9~-][\w.~-]*\/)?[a-z0-9~-][\w.~-]*$/i.test(s);
