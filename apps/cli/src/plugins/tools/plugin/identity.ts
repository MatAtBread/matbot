import type { Runtime }          from '@matatbread/matbot-core';
import { getSpecifierForPlugin } from '@matatbread/matbot-core';
import { readFile }              from 'node:fs/promises';
import { fileURLToPath }         from 'node:url';
import { createRequire }         from 'node:module';
import path                      from 'node:path';

// Resolve a user-supplied handle to the loadable specifier recorded in matbot.yaml. A loaded plugin
// records its config entry as `plugin.specifier`, so the canonical package `name` maps straight to it
// via getSpecifierForPlugin — that's the stable, preferred handle. The literal config entry also works
// (it is its own specifier); anything else falls through unchanged so a direct specifier still loads.
export function toConfigSpecifier(handle: string): string {
  const byName = getSpecifierForPlugin(handle);
  return byName ?? handle;
}

export function normalizeRuntimes(raw: unknown): Runtime[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((r): r is Runtime => r === 'node' || r === 'browser');
}

// Read a plugin's canonical package.json `name` by walking up from the specifier — the same boundary
// the node PluginResolver uses, so a declaration on the plugin (not an enclosing monorepo root) wins.
// file://, paths, and (once installed) bare npm names resolve; a remote github:/https URL does not
// (→ undefined; callers holding a fetched manifest read its name directly).
export async function nameFromSpecifier(specifier: string, projectDir: string): Promise<string | undefined> {
  let dir: string;
  if (specifier.startsWith('file://')) {
    dir = path.dirname(fileURLToPath((specifier.split('?')[0]) ?? specifier));
  } else if (specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier)) {
    dir = path.resolve(projectDir, specifier);
  } else {
    try {
      dir = path.dirname(createRequire(path.join(projectDir, '_')).resolve(specifier));
    } catch {
      return undefined;
    }
  }
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name) return pkg.name;
    } catch { /* no package.json here, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
