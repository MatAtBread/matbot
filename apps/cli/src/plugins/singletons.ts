// Detecting a second physical copy of a host singleton.
//
// `plugin-api` and `core` are shared across the plugin/host boundary, and a second copy is a different
// module object: separate module state, and `instanceof` false across the seam. matbot is deliberately
// hardened against that — state lives on `globalThis`, errors are brand-checked rather than
// `instanceof`'d (docs/duplicate-singletons.md) — so duplication degrades rather than corrupts. Which is
// exactly why this only REPORTS. Nothing here re-links anything: replacing a package-manager-installed
// directory with a symlink invites the next `install` to quietly undo it, and the failure being prevented
// is one the design already survives.
//
// The test is `realpath`, not path existence, because most of the paths that look like duplicates are not.
// The symlink farm under `.plugins/node_modules`, a compiled plugin's scaffold link, and a provisioned
// plugin dir all contain an entry named `@matatbread/matbot-plugin-api` that points AT the host's copy —
// so they collapse to the host's realpath and are silent. What survives the comparison is a genuinely
// separate directory, which in practice means one a package manager fetched from a registry.

import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hostPackageDirFrom, hostOwnPackageDir } from './remote-cache.js';
import type { DuplicateSingleton } from '@matatbread/matbot-core';

const SINGLETONS = ['@matatbread/matbot-plugin-api', '@matatbread/matbot-core'];

function versionOf(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '?';
  } catch { return '?'; }
}

const realOrSelf = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

// The CLI's own dependencies are importers too, and the ones nobody configures: host-node, the storage
// backend and the bundled adapters each resolve the singletons from where the CLI's install put them, so
// a copy nested under one of them is found even when no loaded plugin leads there.
function cliDependencyDirs(): { label: string; dir: string }[] {
  let deps: Record<string, string> = {};
  try {
    deps = (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as
      { dependencies?: Record<string, string> }).dependencies ?? {};
  } catch { /* no manifest beside the source: nothing more to probe from */ }
  return Object.keys(deps).flatMap(name => {
    const dir = hostOwnPackageDir(name);
    return dir === undefined ? [] : [{ label: name, dir }];
  });
}

/** The directory a `file:`-resolved plugin lives in; undefined for anything with no local location. */
function dirOfPlugin(resolvedUrl: string | undefined): string | undefined {
  if (resolvedUrl === undefined || !resolvedUrl.startsWith('file:')) return undefined;
  try { return path.dirname(fileURLToPath(resolvedUrl.split('?')[0]!)); } catch { return undefined; }
}

/**
 * Report every second copy of a host singleton that something here would actually resolve to.
 *
 * Resolution is probed from where each loaded plugin lives, from the config dir when there is one, and from
 * the CLI's own dependencies — not by walking the
 * filesystem for candidate directories. The question worth answering is "what would this plugin get?",
 * which is what a resolver answers and a directory listing only guesses at. A plugin whose imports the
 * module hook serves (one fetched over http) resolves nothing here and is skipped: absence is not
 * duplication.
 */
export function findDuplicateSingletons(opts: {
  configDir?: string;
  plugins:    readonly { name: string; resolvedUrl?: string | undefined }[];
}): DuplicateSingleton[] {
  const bases: { label: string; dir: string }[] = [
    ...(opts.configDir !== undefined ? [{ label: `${path.basename(opts.configDir)}/`, dir: opts.configDir }] : []),
    ...cliDependencyDirs(),
  ];
  for (const p of opts.plugins) {
    const dir = dirOfPlugin(p.resolvedUrl);
    if (dir !== undefined) bases.push({ label: p.name, dir });
  }

  const found = new Map<string, DuplicateSingleton & { reachedFrom: string[] }>();
  for (const pkg of SINGLETONS) {
    const hostDir = hostOwnPackageDir(pkg);
    if (hostDir === undefined) continue;              // this host does not have it: nothing to duplicate
    const hostReal = realOrSelf(hostDir);

    for (const base of bases) {
      const dir = hostPackageDirFrom(pkg, base.dir);
      if (dir === undefined) continue;
      const real = realOrSelf(dir);
      if (real === hostReal) continue;               // a link to the host's copy, which is the point of it

      const key = `${pkg}\0${real}`;
      const existing = found.get(key);
      if (existing !== undefined) { existing.reachedFrom.push(base.label); continue; }
      found.set(key, {
        package:     pkg,
        hostVersion: versionOf(hostReal),
        version:     versionOf(real),
        dir:         real,
        reachedFrom: [base.label],
      });
    }
  }
  return [...found.values()];
}

/** One line per duplicate, for a host that has somewhere to print it. */
export function describeDuplicateSingleton(d: DuplicateSingleton): string {
  return `Two copies of ${d.package} are in play: this host runs ${d.hostVersion}, and ${d.dir} holds ` +
    `${d.version} (reached from ${d.reachedFrom.join(', ')}). Survivable by design — singleton state lives on ` +
    `globalThis and errors are brand-checked, not \`instanceof\`'d — but they are separate module objects. ` +
    `Aligning that copy's version with the host's, or removing it, is what makes it one again.`;
}
