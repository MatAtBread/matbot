import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { classifySpecifier, materializeRemote } from './remote-cache.js';

// What a plugin's code was when it was loaded, so `plugin reload` can tell a re-run of approved code from
// new code. A reload of a resident plugin was never asked about, on the reasoning that its code was already
// trusted — but the code a reload imports is whatever is on disk NOW, or freshly fetched upstream, and the
// model can change both (skills_compiler writes a plugin; `refresh` re-downloads one). The approval was
// for what loaded, so that is what is recorded.
//
// Recorded by the host at each load, in memory: a restart re-records what the configuration loads, and a
// restart is the user's act.

const MAX_FILES = 5000;
const MAX_BYTES = 64 * 1024 * 1024;

/** Where `entry`'s own files are: a local package's directory, an npm package's, or a fetched plugin's
 *  cached copy. Undefined when that cannot be said, which a caller treats as "changed". */
export async function pluginRoot(entry: string, projectDir: string): Promise<string | undefined> {
  const classified = await classifySpecifier(entry, projectDir);
  switch (classified.kind) {
    case 'local': return classified.dir;
    case 'http':  return (await materializeRemote(entry, path.join(projectDir, '.plugins'), projectDir, false)).pkgRoot;
    case 'npm':   return npmRoot(classified.spec, projectDir);
    default:      return undefined;
  }
}

// Resolved as the host resolves it — from the project, then from this install — and walked up from the
// entry to its package.json, since a package's `exports` may not admit `<name>/package.json`.
async function npmRoot(spec: string, projectDir: string): Promise<string | undefined> {
  let entry: string | undefined;
  for (const req of [createRequire(path.join(projectDir, '_')), createRequire(import.meta.url)]) {
    try { entry = req.resolve(spec); break; } catch { /* try the next */ }
  }
  if (entry === undefined) return undefined;
  for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
    try { await access(path.join(dir, 'package.json')); return dir; } catch { /* keep walking up */ }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * A digest of every file under `root`, by relative path and content. Its own `node_modules` and every
 * dot-directory are skipped: dependencies are installed separately (and approved there), and a dot-directory
 * is tooling. Undefined past {@link MAX_FILES} or {@link MAX_BYTES} — a plugin that resolves to a whole
 * project is not one whose code can be vouched for by a digest, so it is always asked about.
 */
export async function fingerprintDir(root: string): Promise<string | undefined> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<boolean> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (!await walk(full)) return false; }
      else if (d.isFile()) { files.push(full); if (files.length > MAX_FILES) return false; }
    }
    return true;
  };
  try { if (!await walk(root)) return undefined; } catch { return undefined; }
  const hash = createHash('sha256');
  let bytes = 0;
  for (const f of files.sort()) {
    const content = await readFile(f).catch(() => undefined);
    if (content === undefined) return undefined;
    bytes += content.length;
    if (bytes > MAX_BYTES) return undefined;
    hash.update(path.relative(root, f)).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

export async function pluginFingerprint(entry: string, projectDir: string): Promise<string | undefined> {
  try {
    const root = await pluginRoot(entry, projectDir);
    return root === undefined ? undefined : await fingerprintDir(root);
  } catch { return undefined; }
}

const loaded = new Map<string, Promise<string | undefined>>();

/** Record what `entry` was loaded from. Hand it a fingerprint taken BEFORE the import, so it describes the
 *  code that ran, not a later edit. */
export function recordLoaded(entry: string, fingerprint: Promise<string | undefined>): void {
  loaded.set(entry, fingerprint.catch(() => undefined));
}

/** What `entry` was last loaded from: absent if it never was in this process, a digest, or undefined for
 *  code no digest could be taken of. */
export function loadedFingerprint(entry: string): Promise<string | undefined> | undefined {
  return loaded.get(entry);
}

export function forgetLoaded(entry: string): void {
  loaded.delete(entry);
}
