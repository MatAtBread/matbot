import type { ToolContext, ToolEvent, ToolResultOf } from '@matatbread/matbot-core';
import { isIncompatibleRuntimeError, isNotAPluginError, refusalMessage, getRegisteredPlugins } from '@matatbread/matbot-core';
import { readFile, access }  from 'node:fs/promises';
import { fileURLToPath }     from 'node:url';
import path                  from 'node:path';
import { classifySpecifier, fetchRemoteManifest, canonicalLocalSpecifier, materializeRemote, releaseRemote,
         type RemoteManifest } from '../../remote-cache.js';
import { mirrorPath } from '../../cache-layout.js';
import { planProvision, applyProvision, discardProvision, removeProvisioned, localProvision, registryManifest,
         planRemoteProvision, applyRemoteProvision, discardRemoteProvision, runCommand,
         type ProvisionPlan } from '../../provision.js';
import { writeInstallRecord, dropInstallRecord, declaredDependencies, isPackageName,
         type InstallRecord } from '../../install-record.js';
import { readPluginsList, addPluginEntry, removePluginEntry, otherRemotes } from '../../config-entries.js';
import { detectPackageManager, addFlags } from '../../package-manager.js';
import { nameFromSpecifier, normalizeRuntimes } from './identity.js';

// `specifier` is a concrete npm name / path / GitHub shorthand / CDN URL. Resolving a fuzzy
// human name ("install the mcp plugin") to a specifier is the model's job (it can run
// `discover_local` first), not the tool's — there is no fuzzy-match step here.
export async function* addPlugin(configPath: string, specifier: string, ctx: ToolContext): AsyncIterable<ToolEvent<ToolResultOf<'plugin'>>> {
  const projectDir = path.dirname(configPath);
  const existing = await readPluginsList(configPath);
  if (existing.includes(specifier)) {
    yield { type: 'result', value: { message: `"${specifier}" is already configured.` } };
    return;
  }

  // The host runtime packages are not plugins — they are the shared singletons every plugin
  // peer-depends on, always already present. The model sometimes tries to "install" them (often
  // with a version suffix, e.g. `@matatbread/matbot-plugin-api@latest`); refuse so they never
  // land in the config as a bogus, unloadable entry.
  if (/^@matatbread\/matbot-(plugin-api|core)(@|$)/.test(specifier)) {
    yield { type: 'error', message:
      `"${specifier}" is a host runtime package (a shared matbot singleton), not a plugin — it is ` +
      `already present and cannot be installed. Nothing was changed.` };
    return;
  }

  // Classification is grounded in what is actually on disk (a stat), not just the string shape:
  // a bare `plugins/foo` is local iff it exists, and a `./`-/`/`-shaped path with no
  // package.json is reported rather than silently mis-installed.
  const classified = await classifySpecifier(specifier, projectDir);
  if (classified.kind === 'missing-path') {
    yield { type: 'error', message:
      `"${specifier}" looks like a local path but no package.json was found at "${classified.resolved}" ` +
      `or any parent directory. Check the path, or pass an npm name, URL, or github: specifier.` };
    return;
  }

  // Everything that can refuse is decided here, before anyone is asked and before anything is written:
  // which package this is, under which name, and whether that name is free. An install that could not be
  // carried through — or taken back exactly — is refused with what to do instead, rather than attempted
  // and then undone by inference.
  let description: string | undefined;
  let pluginName: string | undefined;
  let configSpecifier = specifier;
  let remoteManifest: RemoteManifest | undefined;

  // Pre-fetch verification for remote (raw-source) plugins: confirm the package.json declares
  // matbotRuntime including "node" BEFORE downloading or executing any code, so a stray URL
  // cannot be installed.
  if (classified.kind === 'http') {
    try {
      const manifest = await fetchRemoteManifest(specifier, path.join(projectDir, '.plugins'), /* live */ true);
      const refusal = runtimeRefusal(specifier, manifest.runtimes);
      if (refusal !== undefined) {
        yield { type: 'error', message: refusal };
        return;
      }
      const d = manifest.pkg['description'];
      if (typeof d === 'string') description = d;
      if (typeof manifest.pkg['name'] === 'string') pluginName = manifest.pkg['name'];
      remoteManifest = manifest;
    } catch (e) {
      yield { type: 'error', message: `Could not install "${specifier}": ${e instanceof Error ? e.message : String(e)}.` };
      return;
    }
  }

  // The npm route installs a PLUGIN, by its package name, and reads that package's manifest first — the
  // copy already installed if there is one, else the registry's — so a package that is not a matbot
  // plugin is refused before it is installed, exactly as a URL that is not one is. A version, a tarball
  // or a git URL is refused: which copy of a package the project carries is the project's decision, made
  // with its own package manager, and each of them made what this call installed something it could only
  // guess at afterwards.
  let npmInstall: { pm: string } | undefined;
  if (classified.kind === 'npm') {
    const name = classified.spec;
    if (!isPackageName(name)) {
      yield { type: 'error', message: notAPackageName(specifier, name) };
      return;
    }
    // The entry recorded is the bare name, so with `npm:` forcing past something local that answers to it,
    // the next start would load that instead of what was installed.
    if (specifier !== name && (await classifySpecifier(name, projectDir)).kind !== 'npm') {
      yield { type: 'error', message:
        `Not installing "${name}": something in this project also answers to that name (a directory, or a ` +
        `local package declaring it), and the entry recorded in ${path.basename(configPath)} is the name — ` +
        `so the next start would load that instead of the installed package. Rename or move the local one, ` +
        `or add it by its path if it is the one you mean. Nothing was changed.` };
      return;
    }
    let manifest: Record<string, unknown>;
    const installedAt = await installedPackageDir(name, projectDir);
    if (installedAt !== undefined) {
      try {
        manifest = JSON.parse(await readFile(path.join(installedAt, 'package.json'), 'utf8')) as Record<string, unknown>;
      } catch (e) {
        yield { type: 'error', message: `Could not read the installed "${name}" at ${installedAt}: ${e instanceof Error ? e.message : String(e)}.` };
        return;
      }
    } else {
      // Installing writes the project's package.json, so there has to be one here: without it the package
      // manager writes whichever an enclosing directory has, which this call never read.
      const before = await declaredDependencies(projectDir);
      if (before === undefined) {
        yield { type: 'error', message:
          `Not installing "${name}": there is no package.json in ${projectDir}, so a package manager would ` +
          `record it in whichever enclosing directory has one. Create one there (\`npm init -y\`), or install ` +
          `"${name}" yourself, then add it again. Nothing was changed.` };
        return;
      }
      if (before.has(name)) {
        yield { type: 'error', message:
          `Not installing "${name}": the project's package.json already declares it, but it is not installed. ` +
          `Run \`${await detectPackageManager(projectDir)} install\` in ${projectDir}, then add it again. Nothing was changed.` };
        return;
      }
      try {
        manifest = await registryManifest(name, projectDir);
      } catch (e) {
        yield { type: 'error', message: `Could not install "${name}": ${e instanceof Error ? e.message : String(e)}. Nothing was changed.` };
        return;
      }
      npmInstall = { pm: await detectPackageManager(projectDir) };
    }
    const refusal = runtimeRefusal(name, normalizeRuntimes(manifest['matbotRuntime']));
    if (refusal !== undefined) {
      yield { type: 'error', message: refusal };
      return;
    }
    const d = manifest['description'];
    if (typeof d === 'string') description = d;
    pluginName = name;
    configSpecifier = name;
  }

  // A path is the least portable thing this could record: it is right only for this working copy,
  // while the name resolves here AND in an installed deployment, and is the handle remove/reload
  // address the plugin by. So record the name whenever it resolves back to the directory just
  // approved — the same rule the `provider` tool and the setup wizard already follow.
  if (classified.kind === 'local') {
    description = await pkgDescriptionFromSpecifier(classified.dir, projectDir);
    pluginName = await nameFromSpecifier(classified.dir, projectDir);
    const named = await canonicalLocalSpecifier(classified.dir, projectDir);
    if (named !== undefined) configSpecifier = named;
  }

  if (configSpecifier !== specifier && existing.includes(configSpecifier)) {
    yield { type: 'result', value: { message: `"${specifier}" is already configured, as "${configSpecifier}".` } };
    return;
  }

  // Duplicate-name guard: a plugin's canonical package.json `name` is its identity (and the handle
  // remove/reload address it by), and the registry forbids two loaded plugins sharing one. Almost always
  // the same package added by two specifiers: a config error, not something to silently double-install.
  if (pluginName !== undefined) {
    const clash = getRegisteredPlugins().find(p => p.name === pluginName);
    if (clash !== undefined) {
      yield { type: 'error', message:
        `A plugin named "${pluginName}" is already installed (from "${clash.specifier}"). Remove it first, or — ` +
        `if this is the same package via a different specifier — keep the one you have. To run another ` +
        `version of an npm plugin, install that version with your package manager and \`plugin reload ` +
        `${pluginName}\`. Nothing was changed.` };
      return;
    }
  }

  // A local plugin brings its own dependencies. Where its directory is empty ground they are resolved
  // BEFORE asking — npm's `--package-lock-only` answers "what would this install" without putting a
  // package on disk — so the transitives appear in the approval the user is already being asked for,
  // rather than as a second prompt for consequences of the first. Where the author has installed into
  // it, that install is theirs: complete, it is used as it is, and otherwise they are asked to finish it.
  let plan: ProvisionPlan | undefined;
  if (classified.kind === 'local') {
    const state = await localProvision(classified.dir);
    if ('refuse' in state) {
      yield { type: 'error', message: `Not installing "${specifier}": ${state.refuse}. Nothing was changed.` };
      return;
    }
    if (state.provision) {
      try {
        plan = await planProvision(classified.dir);
      } catch (e) {
        yield { type: 'error', message:
          `Could not resolve the dependencies of "${specifier}": ${e instanceof Error ? e.message : String(e)}. ` +
          `Nothing was changed in ${path.basename(configPath)}.` };
        return;
      }
      if (plan.unsupported.length > 0) {
        // Not a failure: these are workspace/link/file protocols, which say "something already resolves
        // me" — every in-repo plugin looks like this. Say so once, then install as before.
        const ranges = plan.unsupported.map(u => `${u.name}@${u.range}`).join(', ');
        yield { type: 'stdout', chunk:
          `Leaving dependencies to their own resolution (${ranges}) — not registry ranges, so npm is not asked.\n` };
      }
    }
  }

  // A fetched plugin brings its own files only, so what its package.json declares is installed into its
  // cache directory — planned here, from the manifest alone, so the packages are in the same approval and
  // the plugin is loaded once, with them present. (Planning after a load that failed on the first of them
  // was a load that could never succeed, logged as an error, then a second prompt and a retry.)
  let remotePlan: ProvisionPlan | undefined;
  if (remoteManifest !== undefined) {
    try {
      const pkgRoot = path.dirname(mirrorPath(remoteManifest.pkgUrl, path.join(projectDir, '.plugins')));
      remotePlan = await planRemoteProvision(remoteManifest.pkg, pkgRoot);
    } catch (e) {
      yield { type: 'error', message:
        `Could not resolve the dependencies of "${specifier}": ${e instanceof Error ? e.message : String(e)}. ` +
        `Nothing was changed.` };
      return;
    }
    if (remotePlan !== undefined && remotePlan.unsupported.length > 0) {
      const ranges = remotePlan.unsupported.map(u => `${u.name}@${u.range}`).join(', ');
      yield { type: 'stdout', chunk:
        `Not installing its dependencies (${ranges}): not registry ranges, so npm is not asked.\n` };
    }
  }

  // A gate rather than a `confirmed` input parameter: plugin installation is a privileged
  // operation. Breaking the LLM's execution chain and requiring an out-of-band human response
  // prevents prompt injection or a malicious plugin from auto-installing further plugins by simply
  // passing confirmed:true. The SUBJECT is the specifier as typed — at this point the plugin is not
  // loaded, so a policy remembering an answer keys on the spelling, and `@x/foo` and
  // `https://…/foo.ts` are deliberately different decisions.
  const toInstall = plan ?? remotePlan;
  const deps = toInstall !== undefined && toInstall.packages.length > 0
    ? `\n\nIt will also install ${toInstall.packages.length} package(s) from npm` +
      `${remotePlan !== undefined ? ' into its cache directory' : ''}:\n${toInstall.packages.map(p => `- ${p}`).join('\n')}`
    : '';
  const confirmed = await ctx.gate({
    gate:     'add',
    subject:  specifier,
    fallback: false,
    label:    `Install plugin **"${specifier}"**?${description !== undefined ? `\n_${description}_` : ''}${deps}`,
  });
  if (!confirmed.allowed) {
    if (plan !== undefined) await discardProvision(plan);
    if (remotePlan !== undefined) await discardRemoteProvision(remotePlan);
    yield { type: 'result', value: { message: refusalMessage(confirmed) } };
    return;
  }

  // What this call changes outside matbot's own cache, as it changes it: written to the install record
  // once the entry is in config, and taken back if the plugin is then disowned.
  const created: Omit<InstallRecord, 'entry'> = {};
  const dotPlugins = path.join(projectDir, '.plugins');

  if (plan !== undefined && plan.packages.length === 0) await discardProvision(plan);
  if (plan !== undefined && plan.packages.length > 0) {
    yield { type: 'stdout', chunk: `Installing ${plan.packages.length} dependency package(s) with npm...\n` };
    // Provisioning only ever runs on empty ground (`localProvision`), so all of this is the call's own.
    const provisioned = { dir: plan.dir, lockfile: plan.createdLockfile, nodeModules: !plan.hadNodeModules };
    try {
      const { linked, output } = await applyProvision(plan);
      created.provisioned = provisioned;
      if (output) yield { type: 'stdout', chunk: output };
      if (linked.length > 0) yield { type: 'stdout', chunk: `Linked the host's ${linked.join(', ')}.\n` };
    } catch (e) {
      await removeProvisioned(provisioned);
      yield { type: 'error', message:
        `Could not install the dependencies of "${specifier}": ${e instanceof Error ? e.message : String(e)}. ` +
        `What the attempt wrote in ${plan.dir} was removed, and nothing was changed in ${path.basename(configPath)}.` };
      return;
    }
  }

  if (remotePlan !== undefined && remotePlan.packages.length === 0) await discardRemoteProvision(remotePlan);
  if (remotePlan !== undefined && remotePlan.packages.length > 0) {
    yield { type: 'stdout', chunk: `Fetching "${specifier}" and installing ${remotePlan.packages.length} dependency package(s) with npm...\n` };
    try {
      const m = await materializeRemote(specifier, dotPlugins, projectDir);
      const { linked, output } = await applyRemoteProvision(remotePlan, m.pkgRoot);
      if (output) yield { type: 'stdout', chunk: output };
      if (linked.length > 0) yield { type: 'stdout', chunk: `Linked the host's ${linked.join(', ')}.\n` };
    } catch (e) {
      await discardRemoteProvision(remotePlan);
      const released = await releaseRemote(specifier, dotPlugins, await otherRemotes(configPath, projectDir, specifier));
      yield { type: 'error', message:
        `Could not install the dependencies of "${specifier}": ${e instanceof Error ? e.message : String(e)}. ` +
        `${released ? 'What was fetched was removed from the cache, and n' : 'N'}othing was changed in ` +
        `${path.basename(configPath)}.` };
      return;
    }
  }

  if (npmInstall !== undefined) {
    const { pm } = npmInstall;
    yield { type: 'stdout', chunk: `Installing "${configSpecifier}" with ${pm}...\n` };
    try {
      const out = await runCommand(pm, ['add', ...await addFlags(pm, projectDir), configSpecifier], projectDir);
      if (out) yield { type: 'stdout', chunk: out };
    } catch (e) {
      yield { type: 'error', message: await describeInstallFailure(configSpecifier, pm, projectDir, e) };
      return;
    }
    // Not declared before (checked above), so declared now means this call put it there.
    if ((await declaredDependencies(projectDir))?.has(configSpecifier) === true) created.dependency = configSpecifier;
  }

  await addPluginEntry(configPath, configSpecifier);
  await writeInstallRecord(dotPlugins, { entry: configSpecifier, ...created });

  // A plugin that turns out not to be one is disowned: out of config, and everything this call put
  // anywhere taken back — the project's files, and a fetched plugin's cache.
  const disown = async function* (): AsyncGenerator<ToolEvent<ToolResultOf<'plugin'>>, void> {
    await removePluginEntry(configPath, configSpecifier);
    yield* takeBack(created, projectDir);
    await dropInstallRecord(dotPlugins, configSpecifier);
    if (classified.kind === 'http') {
      await releaseRemote(configSpecifier, dotPlugins, await otherRemotes(configPath, projectDir, configSpecifier));
    }
  };

  // For a remote specifier, loadPlugin materialises the module graph into .plugins/ first.
  yield { type: 'stdout', chunk: `Activating "${configSpecifier}"...\n` };
  try {
    const loaded  = await ctx.loadPlugin(configSpecifier);
    const welcome = await loaded.installationMessage?.();
    yield {
      type:  'result',
      value: {
        message: `"${configSpecifier}" installed and is now active.`,
        ...(welcome !== undefined ? { installationMessage: welcome } : {}),
      },
    };
  } catch (e) {
    // A runtime mismatch (wrong host) or a not-plugin-shaped module (a library) is permanent for
    // this specifier, not a fixable hiccup: roll it back out of matbot.yaml so the config never
    // carries an entry that can never activate. Other activation failures (e.g. a missing secret)
    // are left in config to fix and retry.
    if (isIncompatibleRuntimeError(e)) {
      yield* disown();
      yield { type: 'error', message: e.message };
      return;
    }
    // Definitive, not retryable: state the conclusion ("not a matbot plugin") rather than echoing
    // the loader's `reason`, which reads as a code-fix instruction ("Expected: export const plugin")
    // an LLM may try to act on by editing the library's source.
    if (isNotAPluginError(e)) {
      yield* disown();
      yield { type: 'error', message:
        `"${configSpecifier}" is not a matbot plugin — it exports no \`plugin\`, so it cannot be installed ` +
        `(it is most likely a library). Nothing was changed in ${path.basename(configPath)}.` };
      return;
    }
    // Everything its package.json declares as a registry dependency was installed before this load, so an
    // import that resolves nowhere is one it never declared (or declared with a range npm is not asked
    // about). State that plainly, rather than surface the raw module-not-found, which sends the model
    // hunting for npm name variations. The entry is LEFT in config: it activates once the package is
    // present, like any other fixable activation failure.
    const missing = classified.kind === 'http' ? missingPackageOf(e) : undefined;
    if (missing !== undefined) {
      const fromNpm = missing.startsWith('@matatbread/')
        ? `Installing it from npm is simplest — \`${missing}\` — because npm resolves ITS dependencies too.`
        : `Install \`${missing}\` (e.g. from npm) alongside matbot so it is present, or ask the plugin's author to declare it.`;
      yield { type: 'result', value: { message:
        `"${configSpecifier}" was fetched, but it imports "${missing}", which nothing here provides: its ` +
        `package.json does not declare it as a registry dependency, so it was not installed with it. ${fromNpm} ` +
        `Then "${configSpecifier}" activates (it has been left in ${path.basename(configPath)}). Do not retry ` +
        `name variations — the dependency is genuinely missing, not misnamed.` } };
      return;
    }
    yield { type: 'result', value: { message: `"${configSpecifier}" added to config but activation failed: ${String(e)}.` } };
  }
}

// Read the plugin's package.json description without importing the module — the
// confirmation prompt runs before the user has consented to install, so we must not
// execute untrusted plugin code to read manifest.description here. Bare npm names are
// not yet on disk, so they have no resolvable description until after install.
async function pkgDescriptionFromSpecifier(specifier: string, projectDir: string): Promise<string | undefined> {
  let dir: string;

  if (specifier.startsWith('file://')) {
    dir = path.dirname(fileURLToPath((specifier.split('?')[0]) ?? specifier));
  } else if (specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier)) {
    dir = path.resolve(projectDir, specifier);
  } else {
    return undefined; // bare npm package name — not installed yet, nothing to read
  }

  while (true) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { description?: string };
      if (pkg.description) return pkg.description;
    } catch { /* no package.json here, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Why a manifest's `matbotRuntime` means this host must not install it, or undefined if it may. The field is
// what makes a package a matbot plugin before any of its code has run, on every route.
function runtimeRefusal(specifier: string, runtimes: readonly string[] | undefined): string | undefined {
  if (runtimes === undefined) {
    return `Refusing to install "${specifier}": its package.json has no "matbotRuntime" field, so it cannot be ` +
           `verified as a matbot plugin. The plugin tool installs plugins; a plugin's own npm dependencies come ` +
           `with it. Nothing was changed.`;
  }
  if (!runtimes.includes('node')) {
    return `Refusing to install "${specifier}": it declares matbotRuntime [${runtimes.join(', ')}], which excludes ` +
           `the "node" host. Nothing was changed.`;
  }
  return undefined;
}

function notAPackageName(specifier: string, spec: string): string {
  const versioned = spec.match(/^((?:@[^/@\s]+\/)?[^/@\s]+)@\S+$/);
  if (versioned?.[1] !== undefined && isPackageName(versioned[1])) {
    const name = versioned[1];
    return `"${specifier}" names a version. The plugin tool installs an npm plugin by its package name and leaves ` +
           `which version to the project: install it with your package manager (\`npm install ${spec}\`), then ` +
           `\`plugin add ${name}\` — or, if "${name}" is already a plugin here, \`plugin reload ${name}\` to run the ` +
           `version now installed. Nothing was changed.`;
  }
  return `"${specifier}" is not a package name. The plugin tool installs an npm plugin by its name; install a ` +
         `tarball or a git package with your package manager, then \`plugin add <its name>\`. A plugin's source can ` +
         `also be added directly from a github: or https URL. Nothing was changed.`;
}

// Take back, unasked, what an `add` that then disowns the plugin changed in the project: it aborts an
// install approved moments ago in the same call, rather than acting on something the user may still want.
// Only what the call itself was seen to create (install-record.ts) — never a dependency the project
// already declared, and never on the paths that keep the entry in config to retry (a missing secret, an
// unresolved dependency), where the plugin is installed, merely not working yet, and `remove` can reach it.
async function* takeBack(
  created: Omit<InstallRecord, 'entry'>, projectDir: string,
): AsyncGenerator<ToolEvent<ToolResultOf<'plugin'>>, void> {
  if (created.dependency !== undefined) {
    try {
      const out = await runCommand(await detectPackageManager(projectDir), ['remove', created.dependency], projectDir);
      yield { type: 'stdout', chunk: out || `Removed the "${created.dependency}" package again.\n` };
    } catch (e) {
      yield { type: 'stderr', chunk:
        `Could not remove the "${created.dependency}" package again (${String(e)}) — it is still in ` +
        `package.json, so remove it by hand.\n` };
    }
  }
  if (created.provisioned !== undefined) {
    const removed = await removeProvisioned(created.provisioned);
    if (removed.length > 0) yield { type: 'stdout', chunk: `Removed the ${removed.join(' and ')} its install created.\n` };
  }
}

const exists = async (p: string): Promise<boolean> => {
  try { await access(p); return true; } catch { return false; }
};

// Where `name` is installed for the project, by the directory walk a bare import makes — not a resolve, which
// would apply a require condition an ESM-only package's `exports` need not have.
async function installedPackageDir(name: string, projectDir: string): Promise<string | undefined> {
  for (let dir = path.resolve(projectDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (await exists(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

// `name@version` a package manager reports as unresolvable, when it names a package OTHER than the one
// being installed — so a dependency or peer whose RANGE resolved to a version no registry carries.
function unresolvedDependencyOf(raw: string, specifier: string): string | undefined {
  const m = raw.match(/No matching version found for ((?:@[^/\s]+\/)?[^@\s]+)@(\S+?)(?:[\s,]|$)/);
  if (m === null) return undefined;
  const [, name, version] = m;
  if (name === undefined || version === undefined) return undefined;
  // The specifier may carry its own range (`foo@^1`, `@scope/foo@1.2.3`); compare bare names.
  const asked = specifier.replace(/^(@[^/]+\/)?([^@]+).*$/, '$1$2');
  return name === asked ? undefined : `${name}@${version}`;
}

// Turn a raw package-manager failure into an actionable message: name the intent and translate the
// three signatures users actually hit (workspace-only source packages; a dependency resolved to a
// version only this workspace has; registry 404s) instead of dumping the exit code and stderr alone.
async function describeInstallFailure(specifier: string, pm: string, projectDir: string, e: unknown): Promise<string> {
  const raw = e instanceof Error ? e.message : String(e);
  let hint = '';
  const unresolved = unresolvedDependencyOf(raw, specifier);
  if (/workspace:|catalog:/i.test(raw)) {
    hint = ' This looks like a workspace-internal source package (it uses the workspace:/catalog: protocol) ' +
           'and cannot be installed standalone — install the published package, or point at its raw source via a URL / github: specifier.';
  } else if (unresolved !== undefined && await exists(path.join(projectDir, 'pnpm-workspace.yaml'))) {
    // Not the asked-for package: a DEPENDENCY (usually the plugin-api peer) resolved to a version the
    // registry does not carry, which is what happens when the version only exists in this workspace and
    // the package manager is not linking workspace packages — so it goes to the registry for it instead.
    // The registry advice below is actively wrong here: the name is right and the range is satisfiable.
    hint = ` "${unresolved}" is a dependency of it, not the package asked for, and that version looks like ` +
           `one only this workspace provides — so ${pm} went to the registry for a version only local source has. ` +
           `Check that workspace linking is on (pnpm >= 10 reads \`linkWorkspacePackages\` from pnpm-workspace.yaml, ` +
           `NOT from .npmrc, where it is silently ignored).`;
  } else if (/\b404\b|not found|No matching version/i.test(raw)) {
    hint = ' The package or version was not found in the configured registry (check the name, or the registry in your .npmrc).';
  }
  return `Could not install "${specifier}" with ${pm}:${hint}\n${raw}`;
}

// Exported to be tested against the error a real unresolved import throws: it reads a MESSAGE, and the one
// it must read is thrown in apps/cli's ts-hooks, which no compiler ties to this regex.
/** If `e` is a module-resolution failure, the bare package specifier it couldn't find — else undefined.
 *  A raw github/URL fetch copies one plugin's own files, not its dependency graph, so a plugin with a
 *  runtime dependency on another package fails here with the package unresolved. We surface the package
 *  name so the caller can give one readable instruction instead of an opaque ERR_MODULE_NOT_FOUND that
 *  sends the model hunting for name variations.
 *
 *  BOTH wordings must match, and the second is the one that matters. Node's own message is
 *  `Cannot find package 'x' imported from …`, but a bare import from inside the `.plugins/` cache never
 *  reaches it: ts-hooks' `resolveAsHost` retries against the host's graph first and, when that also fails,
 *  throws its own `Cannot resolve "x" imported by …` carrying the same ERR_MODULE_NOT_FOUND code. Matching
 *  only Node's phrasing therefore missed every http plugin — precisely the route this exists for. */
export function missingPackageOf(e: unknown): string | undefined {
  // Walk the cause chain. The error reaching here is the loader's wrapper, not the import rejection, and
  // one layer forgetting to carry `code` made this return undefined for every http plugin — the failure
  // this exists to explain. Reading through the chain does not depend on every future wrapper
  // remembering.
  let cur: unknown = e;
  let found = false;
  for (let depth = 0; cur instanceof Error && depth < 8; depth++) {
    if ((cur as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') { found = true; break; }
    cur = (cur as { cause?: unknown }).cause;
  }
  if (!found || !(e instanceof Error)) return undefined;
  const m = /Cannot (?:find (?:package|module)|resolve) ['"]([^'"]+)['"]/.exec(e.message);
  const pkg = m?.[1];
  // A bare package specifier (not a relative/absolute path): that's a missing dependency, not a
  // broken internal import.
  return pkg !== undefined && !pkg.startsWith('.') && !pkg.startsWith('/') ? pkg : undefined;
}
