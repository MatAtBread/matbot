// The build dir of a compiled plugin, written before any code is generated into it.
//
// It is a package the compiler owns end to end — the checker reads its tsconfig, Node imports its
// entry — and it must not depend on `matbot.yaml` happening to sit at the root of a matbot source
// checkout. It did, twice: the tsconfig `extends`-ed `<configDir>/tsconfig.base.json` and the
// node_modules link pointed at `<configDir>/plugin-api`. Both are absent in an installed deployment,
// where the consequences were silent and separately bad:
//
//   - `symlink()` succeeds against a nonexistent target, so the link was created, reported as a
//     success, and dangled. The generated plugin then failed its own typecheck with `TS2307: Cannot
//     find module '@matatbread/matbot-plugin-api'` on line 1 — an error attributed to the model's code,
//     which the repair loop cannot fix and burns every pass trying to, next to a HINT saying that the
//     module it just failed to resolve is the only importable one.
//   - an unreadable `extends` is not an error, it is a shrug: the options simply do not apply.
//     `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `erasableSyntaxOnly` all quietly
//     stopped holding, so the gate graded generated code more loosely than the repo grades its own —
//     and `erasableSyntaxOnly` is the one that keeps a plugin LOADABLE (measured: an `enum` passes the
//     weakened check, then dies as "TypeScript enum is not supported in strip-only mode").
//
// So the tsconfig is self-contained and the link target is resolved, not assumed.

import { mkdir, writeFile, readFile, symlink, lstat, rm, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import path from 'node:path';

const PLUGIN_API = '@matatbread/matbot-plugin-api';

/**
 * The host's plugin-api package directory, resolved the way the remote-plugin bridge resolves a host
 * singleton: from the config dir first (a package the user installed in their own project), then from
 * this module, which can always reach it — skills_compiler peer-depends on it, so whatever copy the
 * host loaded is the copy found here. Two steps because matbot packages export only `.`, which blocks
 * the `${name}/package.json` subpath.
 */
export function hostPluginApiDir(configDir: string): string | undefined {
  for (const req of [createRequire(path.join(configDir, '_')), createRequire(import.meta.url)]) {
    try { return path.dirname(req.resolve(`${PLUGIN_API}/package.json`)); } catch { /* exports blocks it */ }
    let dir: string;
    try { dir = path.dirname(req.resolve(PLUGIN_API)); } catch { continue; }
    for (;;) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
        if (pkg.name === PLUGIN_API) return dir;
      } catch { /* no readable package.json here, keep walking up */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

// Exactly what `tsconfig.base.json` gave this build when one happened to be there, so a source
// checkout sees no change — minus the emit options, which a typecheck-only build has always turned
// off. Inlined rather than referenced: a generated plugin is graded on matbot's terms wherever it is
// built, and a `tsconfig.base.json` that belongs to some unrelated project of the user's is not a
// standard to inherit.
const COMPILER_OPTIONS = {
  target: 'ES2024',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  lib: ['ES2024', 'DOM', 'DOM.Iterable'],
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  verbatimModuleSyntax: true,
  erasableSyntaxOnly: true,
  forceConsistentCasingInFileNames: true,
  skipLibCheck: false,
  declaration: false,
  declarationMap: false,
  sourceMap: false,
} as const;

export class ScaffoldError extends Error {}

/**
 * Write the build dir's package.json, tsconfig.json and ambient tool dts, and link plugin-api into it.
 *
 * Returns the version written: recompiling to the same destination is a new version, not a silent
 * overwrite, so an existing package.json's patch is bumped and a first compile starts at 0.1.0.
 *
 * The link is the ONLY way `@matatbread/matbot-plugin-api` resolves here, for tsc and for Node alike —
 * there is deliberately no `paths` entry duplicating it. One mechanism means a link that is wrong
 * fails the typecheck, before the plugin is installed; two meant the typecheck passed against `paths`
 * and the import failed at load, which is the failure this build is least able to explain.
 */
export async function writePluginScaffold(opts: {
  buildDir:         string;
  configDir:        string;
  pkgName:          string;
  toolContractsDts: string;
  /** The tool's one-line description. The host backfills a plugin's manifest description from here, so
   *  `plugin list` describes the package whatever the generated source declares. Omitted on iterate,
   *  which keeps whatever the previous build wrote. */
  description?:     string;
}): Promise<{ version: string }> {
  const apiDir = hostPluginApiDir(opts.configDir);
  if (apiDir === undefined) {
    throw new ScaffoldError(
      `could not resolve ${PLUGIN_API} from "${opts.configDir}" or from the compiler itself. ` +
      `A compiled plugin is typechecked and loaded against the host's own copy, so the build cannot proceed without it.`,
    );
  }

  let version = '0.1.0';
  let description = opts.description;
  try {
    const existing = JSON.parse(await readFile(path.join(opts.buildDir, 'package.json'), 'utf8')) as { version?: string; description?: string };
    const m = typeof existing.version === 'string' ? existing.version.match(/^(\d+)\.(\d+)\.(\d+)$/) : null;
    if (m) version = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
    // An iterate pass has no design step to describe the tool, and rewriting the manifest without one
    // would silently strip the description an earlier build wrote.
    if (description === undefined && typeof existing.description === 'string') description = existing.description;
  } catch { /* no existing package.json → first version */ }

  try {
    await mkdir(path.join(opts.buildDir, 'src'), { recursive: true });
    await writeFile(path.join(opts.buildDir, 'package.json'), JSON.stringify({
      name: opts.pkgName, matbotRuntime: ['node'], version, type: 'module',
      ...(description !== undefined ? { description } : {}),
      exports: { '.': './src/index.ts' }, files: ['src'],
      peerDependencies: { [PLUGIN_API]: '*' },
    }, null, 2));
    await writeFile(path.join(opts.buildDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: COMPILER_OPTIONS,
      include: ['src/**/*'],
    }, null, 2));
    await writeFile(path.join(opts.buildDir, 'src', 'matbot-tools.d.ts'), opts.toolContractsDts);
  } catch (e) {
    throw new ScaffoldError(`could not write the plugin scaffold: ${e instanceof Error ? e.message : String(e)}`);
  }

  // A link left by an earlier compile is replaced unless it already points somewhere real: the failure
  // being fixed here left exactly such a link behind, and `readlink` succeeding says only that a
  // symlink exists, never that it leads anywhere.
  const linkDir  = path.join(opts.buildDir, 'node_modules', '@matatbread');
  const linkPath = path.join(linkDir, 'matbot-plugin-api');
  try {
    await mkdir(linkDir, { recursive: true });
    let usable = false;
    try { await lstat(linkPath); usable = await exists(linkPath); } catch { /* nothing there */ }
    if (!usable) {
      await rm(linkPath, { recursive: true, force: true });
      await symlink(apiDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    }
  } catch (e) {
    throw new ScaffoldError(`could not link ${PLUGIN_API} into the build dir: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { version };
}

/** `access` follows symlinks, so this is false for a link whose target is gone. */
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
