import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProjectDir } from '@matatbread/matbot-tool-types';
import { writePluginScaffold, hostPluginApiDir } from '@matatbread/matbot-tool-skill-compiler';

// The compiler builds into `<configDir>/compiled-plugins/<tool>`, and used to assume `<configDir>` was
// the root of a matbot SOURCE CHECKOUT: the tsconfig extended `<configDir>/tsconfig.base.json` and the
// node_modules link pointed at `<configDir>/plugin-api`. An installed deployment has neither, and both
// failures were silent — so every test here uses a bare temp dir as the config dir, which is what an
// installed deployment looks like.
async function installedDeployment(): Promise<{ configDir: string; buildDir: string; cleanup: () => Promise<void> }> {
  const configDir = await mkdtemp(join(tmpdir(), 'matbot-installed-'));
  const buildDir  = join(configDir, 'compiled-plugins', 'demo');
  await mkdir(buildDir, { recursive: true });
  return { configDir, buildDir, cleanup: () => rm(configDir, { recursive: true, force: true }) };
}

const VALID = `import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
export const plugin: MatbotPluginSpec = { apiVersion: PLUGIN_API_VERSION };
`;

test('a plugin built outside a source checkout typechecks and can resolve plugin-api', async () => {
  const { configDir, buildDir, cleanup } = await installedDeployment();
  try {
    const { version } = await writePluginScaffold({ buildDir, configDir, pkgName: '@local/compiled-demo', toolContractsDts: '' });
    assert.equal(version, '0.1.0', 'a first compile starts at 0.1.0');
    await writeFile(join(buildDir, 'src', 'index.ts'), VALID);

    // Previously: TS2307 "Cannot find module '@matatbread/matbot-plugin-api'" on line 1 — an error
    // attributed to the generated code, which the repair loop cannot fix and spends every pass on.
    const res = await checkProjectDir(buildDir);
    assert.ok(res.ok, `the scaffold must typecheck; got:\n${res.output}`);

    // The typecheck resolving is not enough on its own: the same link is what Node resolves through at
    // load time, so the plugin has to actually import.
    const mod = await import(join(buildDir, 'src', 'index.ts')) as { plugin?: { apiVersion?: string } };
    assert.equal(typeof mod.plugin?.apiVersion, 'string', 'the built plugin must import at runtime too');
  } finally {
    await cleanup();
  }
});

// The scaffold's tsconfig no longer inherits from a file next to matbot.yaml, so the strict options have
// to be in it. That is not pedantry: `erasableSyntaxOnly` is what keeps a plugin LOADABLE, because
// plugins load under node's strip-only mode. With the options merely inherited-if-present, this exact
// enum passed the gate and then died at import with "TypeScript enum is not supported in strip-only mode".
test('the gate still rejects what only the strict options reject', async () => {
  const { configDir, buildDir, cleanup } = await installedDeployment();
  try {
    await writePluginScaffold({ buildDir, configDir, pkgName: '@local/compiled-demo', toolContractsDts: '' });

    for (const [why, src] of [
      ['an enum (unloadable under strip-only)',  `enum Mode { A, B }\nexport const plugin = { apiVersion: '0.4', mode: Mode.A };\n`],
      ['an unchecked index access',              `export function first(xs: string[]): string { const s: string = xs[0]; return s; }\nexport const plugin = { apiVersion: '0.4' };\n`],
      ['an implicit any',                        `export function widen(rows): unknown { return rows; }\nexport const plugin = { apiVersion: '0.4' };\n`],
    ] as const) {
      await writeFile(join(buildDir, 'src', 'index.ts'), src);
      const res = await checkProjectDir(buildDir);
      assert.equal(res.ok, false, `${why} must be rejected`);
    }
  } finally {
    await cleanup();
  }
});

// A compile that failed the old way left a dangling link behind, and `readlink` succeeding says only
// that a symlink exists — never that it leads anywhere. So the next compile inherited the breakage.
test('a dangling link left by an earlier build is replaced, not kept', async () => {
  const { configDir, buildDir, cleanup } = await installedDeployment();
  try {
    const linkDir = join(buildDir, 'node_modules', '@matatbread');
    await mkdir(linkDir, { recursive: true });
    await symlink(join(configDir, 'plugin-api'), join(linkDir, 'matbot-plugin-api'));   // what the old code wrote

    await writePluginScaffold({ buildDir, configDir, pkgName: '@local/compiled-demo', toolContractsDts: '' });
    await writeFile(join(buildDir, 'src', 'index.ts'), VALID);
    const res = await checkProjectDir(buildDir);
    assert.ok(res.ok, `the dangling link should have been replaced; got:\n${res.output}`);
  } finally {
    await cleanup();
  }
});

test('recompiling the same destination bumps the patch rather than overwriting silently', async () => {
  const { configDir, buildDir, cleanup } = await installedDeployment();
  try {
    assert.equal((await writePluginScaffold({ buildDir, configDir, pkgName: '@local/compiled-demo', toolContractsDts: '' })).version, '0.1.0');
    assert.equal((await writePluginScaffold({ buildDir, configDir, pkgName: '@local/compiled-demo', toolContractsDts: '' })).version, '0.1.1');
    const pkg = JSON.parse(await readFile(join(buildDir, 'package.json'), 'utf8')) as { version: string; peerDependencies: Record<string, string> };
    assert.equal(pkg.version, '0.1.1');
    // `workspace:^` was the third checkout assumption in the generated manifest: it means nothing
    // outside a pnpm workspace, and phase 3 runs a package manager in this very directory.
    assert.equal(pkg.peerDependencies['@matatbread/matbot-plugin-api'], '*');
  } finally {
    await cleanup();
  }
});

// Every compiled plugin showed a blank description in `plugin list`, because the generated plugin
// declared no manifest and the manifest is where a loaded plugin's description is read from. The
// package.json is the deterministic half of the fix — the host backfills from it, so it holds whatever
// the generated source happens to declare.
test('the scaffold records the tool description, and an iterate pass does not strip it', async () => {
  const { configDir, buildDir, cleanup } = await installedDeployment();
  const read = async () => (JSON.parse(await readFile(join(buildDir, 'package.json'), 'utf8')) as { description?: string }).description;
  try {
    await writePluginScaffold({ buildDir, configDir, pkgName: '@local/compiled-demo', toolContractsDts: '', description: 'Import skills from a remote matbot.' });
    assert.equal(await read(), 'Import skills from a remote matbot.');

    // Iterate has no design step, so it passes no description — and must not blank the one already there.
    await writePluginScaffold({ buildDir, configDir, pkgName: '@local/compiled-demo', toolContractsDts: '' });
    assert.equal(await read(), 'Import skills from a remote matbot.', 'carried forward, not dropped');
  } finally {
    await cleanup();
  }
});

// The resolution itself, since everything above rests on it: found from the compiler's own location
// even when the config dir knows nothing about matbot.
test('plugin-api resolves from the compiler when the config dir cannot supply it', async () => {
  const { configDir, cleanup } = await installedDeployment();
  try {
    const dir = hostPluginApiDir(configDir);
    assert.ok(dir !== undefined, 'must resolve');
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name: string };
    assert.equal(pkg.name, '@matatbread/matbot-plugin-api', 'and must be the real package, not a parent directory');
  } finally {
    await cleanup();
  }
});

// The dts is an INPUT to code generation, derived from the live registry. A generated tool that declares a
// `ToolContracts` arm for some OTHER tool is not describing anything — it is asserting a shape tsc then
// cannot contradict, so a wrong guess compiles and fails at runtime. The cast gate cannot see it (nothing is
// cast), which is why it is its own structural rule. Measured before this existed: with the derived dts
// unavailable, a compile that needed `whoami` declared `ToolContract<{ id: string; type: string }, {}>` for
// it — clean typecheck, invented contract.
test('a generated tool may declare its own contract and no other', async () => {
  const { configDir, buildDir, cleanup } = await installedDeployment();
  const arm = (name: string): string =>
    `import type { MatbotPluginSpec, ToolContract } from '@matatbread/matbot-plugin-api';\n` +
    `declare module '@matatbread/matbot-plugin-api' {\n  interface ToolContracts {\n` +
    `    ${name}: ToolContract<{ ok: boolean }, Record<string, never>>;\n  }\n}\n` +
    `export const plugin: MatbotPluginSpec = { apiVersion: '0.4' };\n`;
  try {
    await writePluginScaffold({ buildDir, configDir, pkgName: '@local/compiled-demo', toolContractsDts: '' });

    // Its own arm: exactly what the template tells it to keep.
    await writeFile(join(buildDir, 'src', 'index.ts'), arm('demo_tool'));
    const own = await checkProjectDir(buildDir, { ownContracts: ['demo_tool'] });
    assert.ok(own.ok, `a tool's own contract must pass; got:\n${own.output}`);

    // Somebody else's: rejected, and the message has to say what to do instead.
    await writeFile(join(buildDir, 'src', 'index.ts'), arm('whoami'));
    const foreign = await checkProjectDir(buildDir, { ownContracts: ['demo_tool'] });
    assert.equal(foreign.ok, false, 'an invented contract for another tool must be rejected');
    assert.match(foreign.output, /CAST-GATE/, 'reported as a gate finding, not a tsc error');
    assert.match(foreign.output, /'whoami' is not yours to declare/);

    // Without the option the rule does not run — it cannot tell an invention from a self-declaration.
    const unscoped = await checkProjectDir(buildDir);
    assert.ok(unscoped.ok, `unscoped checks must be unaffected; got:\n${unscoped.output}`);
  } finally {
    await cleanup();
  }
});
