import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getSpecifierForPlugin, loadPlugins } from '@matatbread/matbot-core';
import type { MatbotPlugin, PluginManifest, MatbotServices, PromptFn } from '@matatbread/matbot-core';

// Where to begin the upward package.json search for a load specifier. Specifiers that
// reach the runtime are file: URLs (resolved by the CLI before registration); install-time
// specifiers may be relative paths or bare npm names. A bare name is resolved through the
// project's module graph, which only works once the package is actually on disk.
function startDir(specifier: string, baseDir: string): string | undefined {
  const bare = (specifier.split('?')[0]) ?? specifier;
  if (bare.startsWith('file://')) return path.dirname(fileURLToPath(bare));
  if (bare.startsWith('./') || bare.startsWith('../') || path.isAbsolute(bare)) {
    return path.resolve(baseDir, bare);
  }
  try {
    const require = createRequire(pathToFileURL(path.join(baseDir, 'index.js')).href);
    return path.dirname(require.resolve(bare));
  } catch {
    return undefined;
  }
}

async function descriptionFromPackageJson(specifier: string, baseDir: string): Promise<string | undefined> {
  let dir = startDir(specifier, baseDir);
  if (dir === undefined) return undefined;
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { description?: string };
      if (pkg.description) return pkg.description;
    } catch { /* no package.json here, keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Fill in plugin.manifest.description from the plugin's package.json, unless the plugin
// already declares a description. Presence is checked with `in` so a getter (a description
// computed at read time from some condition) counts as declared and is left untouched —
// we never read it, only observe that it exists.
export async function backfillPluginDescription(
  plugin:    MatbotPlugin,
  specifier: string,
  baseDir:   string,
): Promise<void> {
  if (plugin.manifest !== undefined && 'description' in plugin.manifest) return;
  const description = await descriptionFromPackageJson(specifier, baseDir);
  if (description === undefined) return;
  if (plugin.manifest !== undefined) {
    (plugin.manifest as { description?: string }).description = description;
  } else {
    (plugin as { manifest?: PluginManifest }).manifest = { description };
  }
}

// loadPlugins lives in the platform-neutral runner and so cannot read package.json itself.
// This wrapper is the Node entry point: every CLI plugin load goes through it, so a freshly
// loaded plugin always has its package.json description folded into its manifest. baseDir is
// the project directory (where package.json paths and node_modules resolve from).
export async function loadPluginsWithDescriptions(
  specifiers: readonly string[],
  services:   MatbotServices,
  baseDir:    string,
  bustCache = false,
  prompt?:    PromptFn,
): Promise<MatbotPlugin[]> {
  const plugins = await loadPlugins(specifiers, services, bustCache, prompt);
  for (const plugin of plugins) {
    const specifier = getSpecifierForPlugin(plugin.name);
    if (specifier !== undefined) await backfillPluginDescription(plugin, specifier, baseDir);
  }
  return plugins;
}
