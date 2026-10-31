import { readFileSync, realpathSync } from 'node:fs';
import { createRequire }              from 'node:module';
import { fileURLToPath }              from 'node:url';
import path                           from 'node:path';
import { isBackground }               from './terminal.js';

const SINGLETONS = ['@matatbread/matbot-core', '@matatbread/matbot-plugin-api'];

// Walk up from a resolved module entry to the owning package.json (a package's `exports` may not
// expose package.json), returning the `name`d package's real directory and version.
function packageAt(entryPath: string, name: string): { root: string; version: string } | undefined {
  let dir = path.dirname(entryPath);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === name) return { root: realpathSync(dir), version: pkg.version ?? '?' };
    } catch { /* no package.json here — keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function selfPackage(): { version?: string; dependencies?: Record<string, string> } {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: string; dependencies?: Record<string, string> };
  } catch { return {}; }
}

export function selfVersion(): string {
  return selfPackage().version ?? '?';
}

function resolvePackage(from: string, name: string): { root: string; version: string } | undefined {
  try { return packageAt(createRequire(from).resolve(name), name); } catch { return undefined; }
}

// The singletons as reached from the CLI and from each of its own dependencies — every importer the
// CLI brings, so a nested copy under one of them is found.
function singletonCopies(dependencies: readonly string[]): Map<string, Set<string>> {
  const self = fileURLToPath(import.meta.url);
  const importers = [self, ...dependencies.flatMap(d => {
    try { return [createRequire(self).resolve(d)]; } catch { return []; }
  })];
  const copies = new Map<string, Set<string>>();
  for (const name of SINGLETONS) {
    const roots = new Set<string>();
    for (const from of importers) {
      const at = resolvePackage(from, name);
      if (at) roots.add(at.root);
    }
    copies.set(name, roots);
  }
  return copies;
}

// One line naming the CLI version and the *resolved* singleton versions. plugin-api is resolved
// *through* core (cli → core → plugin-api), which is how the import graph actually reaches it and the
// exact instance the principal carrier lives in. The warning compares resolved DIRECTORIES, never
// version numbers: packages are versioned independently (a frontend release bumps the CLI and not core),
// so differing numbers are normal, while two physical copies of a singleton are what split shared
// module state — and they can carry the same version.
export function versionBanner(): string {
  const pkg = selfPackage();
  const core = resolvePackage(fileURLToPath(import.meta.url), '@matatbread/matbot-core');
  const api = core ? resolvePackage(path.join(core.root, 'package.json'), '@matatbread/matbot-plugin-api') : undefined;
  let line = `matbot v${pkg.version ?? '?'} (core ${core?.version ?? '?'}, plugin-api ${api?.version ?? '?'}, isSubAgent ${isBackground})`;
  for (const [name, roots] of singletonCopies(Object.keys(pkg.dependencies ?? {}))) {
    if (roots.size < 2) continue;
    line += `\n⚠ duplicate singleton: ${name} resolves to ${roots.size} copies (${[...roots].join(', ')}). Run a clean `
          + 'reinstall (rm -rf node_modules package-lock.json && npm i) — duplicate copies split shared state.';
  }
  return line;
}
