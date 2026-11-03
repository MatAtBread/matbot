import { readFileSync, realpathSync } from 'node:fs';
import { createRequire }              from 'node:module';
import { fileURLToPath }              from 'node:url';
import path                           from 'node:path';
import { isBackground }               from './terminal.js';

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

function selfPackage(): { version?: string } {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: string };
  } catch { return {}; }
}

export function selfVersion(): string {
  return selfPackage().version ?? '?';
}

function resolvePackage(from: string, name: string): { root: string; version: string } | undefined {
  try { return packageAt(createRequire(from).resolve(name), name); } catch { return undefined; }
}

// One line naming the CLI version and the *resolved* singleton versions. plugin-api is resolved
// *through* core (cli → core → plugin-api), which is how the import graph actually reaches it and the
// exact instance the principal carrier lives in. A second copy of either is not this line's to report:
// `findDuplicateSingletons` says so once, after boot has loaded the plugins that might lead to one.
export function versionBanner(): string {
  const pkg = selfPackage();
  const core = resolvePackage(fileURLToPath(import.meta.url), '@matatbread/matbot-core');
  const api = core ? resolvePackage(path.join(core.root, 'package.json'), '@matatbread/matbot-plugin-api') : undefined;
  return `matbot v${pkg.version ?? '?'} (core ${core?.version ?? '?'}, plugin-api ${api?.version ?? '?'}, isSubAgent ${isBackground})`;
}
