import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Where a matbot package's types are read from, for every Program tool-types builds: the monorepo source
// if present, then the project's own install, and finally THIS module's own resolution — which reaches the
// copy the host loaded, tool-types peer-depending on plugin-api (and core, through it). For a plugin fetched
// over http, "this module" is the mirrored copy, and the cache's `node_modules` links the host's singletons.
//
// One function because there were two copies, and they drifted: the dts build had the last step and the
// snippet check did not, so in any project where plugin-api is not resolvable from the config directory (a
// pnpm project, a globally installed CLI, a bare directory holding only matbot.yaml) the check's import of
// plugin-api failed, `tool` was `any`, and every tool call in a function body typechecked — a wrong
// argument, an unknown property, a tool that does not exist.
export function anchorPackage(projectRoot: string, dir: string, name: string): string | undefined {
  const monorepo = join(projectRoot, dir, 'src', 'index.ts');
  if (existsSync(monorepo)) return monorepo;
  for (const from of [join(projectRoot, '_'), fileURLToPath(import.meta.url)]) {
    try { return createRequire(from).resolve(name); } catch { /* try the next anchor */ }
  }
  return undefined;
}
