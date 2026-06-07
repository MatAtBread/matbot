import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginResolver } from '@matatbread/matbot-core';
import { startDir } from './plugin-description.js';

/**
 * Node host PluginResolver: derives a plugin's canonical name (its package.json `name`) from the
 * specifier it was loaded with. This is the single source of plugin identity on the node host —
 * the loader calls identify() to stamp `MatbotPlugin.name`, so authors no longer hand-declare it.
 *
 * A bare npm name is already the package name and passes through. A path / file: URL is resolved to
 * a start directory and the nearest package.json walked up to; its `name` wins, falling back to the
 * directory's basename if no package.json carries one.
 */
export function nodePluginResolver(baseDir: string): PluginResolver {
  return {
    async identify(specifier: string): Promise<string> {
      const bare = (specifier.split('?')[0]) ?? specifier;
      const isPathLike = bare.startsWith('file://') || bare.startsWith('./') ||
                         bare.startsWith('../')     || path.isAbsolute(bare);
      if (!isPathLike) return specifier; // bare npm name — already the package name

      let dir = startDir(specifier, baseDir);
      if (dir === undefined) return specifier;
      const fallback = path.basename(dir);

      while (true) {
        try {
          const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
          if (pkg.name) return pkg.name;
        } catch { /* no package.json here, keep walking up */ }
        const parent = path.dirname(dir);
        if (parent === dir) return fallback; // filesystem root reached without a named package.json
        dir = parent;
      }
    },
  };
}
