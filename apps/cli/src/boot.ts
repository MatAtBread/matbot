import { loadPluginsWithDescriptions, nodePluginResolver,
         createAlsPrincipalCarrier, createAlsUsageCarrier, EnvFileVault } from '@matatbread/matbot-host-node';
import type { PromptFn, AssembledMachine, Tool } from '@matatbread/matbot-core';
import { ProviderRegistryImpl,
         unloadPlugin as unloadPluginFn,
         getFailedPlugins, getPluginNameForSpecifier, getRegisteredPlugins,
         installPrincipalCarrier, installUsageCarrier, enterPrincipal,
         assembleMachine, preScanStorage, isProviderAlias } from '@matatbread/matbot-core';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';
import { stripTypeScriptTypes }     from 'node:module';
import process                      from 'node:process';
import path                         from 'node:path';
import { findUp, loadConfig, loadConfigFromText, loadDotEnv, readDotEnv, withholdDotEnv,
         type MatbotConfig } from './config.js';
import type { CliOpts }             from './args.js';
import { resolveBootPrincipal }     from './args.js';
import { selfVersion, versionBanner } from './banner.js';
import { runSetupWizard }           from './setup-wizard.js';
import { resolvePluginSpecifiers, packageNameResolves } from './specifiers.js';
import { isBackground, stamp, yellow } from './terminal.js';
import { createPluginTool }         from './plugins/tools/plugin.js';
import { createProviderTool }       from './plugins/tools/provider.js';
import { findDuplicateSingletons, describeDuplicateSingleton } from './plugins/singletons.js';
import { pluginFingerprint, recordLoaded } from './plugins/fingerprint.js';

/**
 * Find and read the configuration, running the setup wizard when there is none, and move into its project:
 * the CLI's working directory is the directory of the config it booted with.
 */
export async function loadCliConfig(opts: CliOpts): Promise<{ config: MatbotConfig; configPath: string }> {
  let config!: MatbotConfig;
  let configPath: string;

  if (opts.config === '-') {
    // Read YAML from stdin; project root anchors to the base config via extends:
    const text = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (c: Buffer) => chunks.push(c));
      process.stdin.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
    const loaded = await loadConfigFromText(text, process.cwd());
    config     = loaded.config;
    configPath = path.join(loaded.projectDir, 'matbot.yaml'); // virtual — used for plugin resolution
    process.chdir(loaded.projectDir);
    await loadDotEnv(loaded.projectDir);
  } else {
    // Resolve relative paths against INIT_CWD (set by pnpm/npm to the directory
    // from which the user ran the package manager) so --config foo.yaml lands
    // next to the user's project, not inside the CLI package directory.
    const userCwd = process.env['INIT_CWD'] ?? process.cwd();
    configPath = opts.config === './matbot.yaml'
      ? (await findUp('matbot.yaml')) ?? path.resolve(userCwd, 'matbot.yaml')
      : path.isAbsolute(opts.config) ? opts.config : path.resolve(userCwd, opts.config);
    process.chdir(path.dirname(configPath));
    await loadDotEnv(path.dirname(configPath));
    let loadResult: { config: MatbotConfig; projectDir: string } | null = null;
    try {
      loadResult = await loadConfig(configPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    if (loadResult !== null) {
      config = loadResult.config;
      if (loadResult.projectDir !== path.dirname(configPath)) {
        process.chdir(loadResult.projectDir);
        configPath = path.join(loadResult.projectDir, 'matbot.yaml');
      }
    }
    if (loadResult === null || config.providers.size === 0) {
      config = await runSetupWizard(configPath);
    }
  }
  // Part of the CLI's command-line contract, beside IS_SUB_AGENT and MATBOT_PRINCIPAL: what a plugin that
  // starts this CLI again (background-jobs-node) extends, so the copy boots on the same configuration.
  process.env['MATBOT_CONFIG'] = configPath;
  return { config, configPath };
}

export type BootedMachine = Omit<AssembledMachine, 'loaded' | 'dispose'> & { providers: ProviderRegistryImpl };

/** Stand the machine up: carriers and boot identity, the boot storage and vault, then every configured plugin. */
export async function bootMachine(opts: CliOpts, config: MatbotConfig, configPath: string): Promise<BootedMachine> {
  // Install the ambient security carrier before anything that could read it. The node app uses an
  // AsyncLocalStorage carrier so concurrent turns / frontend requests stay isolated; entering the
  // boot principal here gives the CLI process its identity for any out-of-turn backend access
  // (frontend handlers and per-turn pumps shadow it with their own principal via runAs). The boot
  // identity is resolved at this entry — flag → MATBOT_PRINCIPAL → config → system — so a pod or a
  // delegating parent (the background plugin) can supply it without any shared-package env reads.
  installPrincipalCarrier(createAlsPrincipalCarrier());
  installUsageCarrier(createAlsUsageCarrier());
  enterPrincipal(resolveBootPrincipal(opts, config));

  process.stderr.write(yellow(`${stamp()} [matbot] ${versionBanner()}\n`));

  const configDir = path.dirname(configPath);
  const dotData   = path.join(configDir, '.data');

  // Resolve plugin specifiers here so we can pre-scan for a storage backend before any store exists.
  // A plugin with storageBackend replaces the host's filesystem stores, so it must be listed before any
  // plugin whose setup() calls createStore.
  const providers            = new ProviderRegistryImpl(config.providers);
  const providerModules      = [...new Set([...providers.values()].flatMap(e => isProviderAlias(e) ? [] : [e.module]))];
  const resolvedProviderMods = await resolvePluginSpecifiers(providerModules, configDir);
  const resolvedPluginMods   = await resolvePluginSpecifiers(config.plugins, configDir);
  const preScanned           = await preScanStorage([...resolvedProviderMods, ...resolvedPluginMods], dotData);

  // What a `tool_function` body may reach, and for how long, is NOT this host's business: it is a
  // `FunctionRunner`, which `@matatbread/matbot-function-runner-node` registers as an ordinary plugin.
  // Absent, a body compiles with `new AsyncFunction` and runs unbounded, unshadowed and ungated — which
  // is what matbot does without opinions, and what the declarations a body is written against then say.

  // Read here, after a first-run wizard may have written to it. The environment wins over the file, as it
  // always has; and once the vault holds the file's keys they are taken out of the environment.
  const dotEnv = await readDotEnv(configDir);
  const bootVault = new EnvFileVault(path.join(configDir, '.env'), { ...dotEnv, ...process.env });
  withholdDotEnv(dotEnv);

  // Map plugin name → the original module specifier written in matbot.yaml. Used by the provider
  // tool as the write-back fallback for a local adapter that has no resolvable package name, and to
  // match an LLM-supplied path against a loaded adapter. Declared before the machine, since the provider
  // tool below is built before any plugin loads; it is filled in as they do.
  const pluginNameToOrigPath = new Map<string, string>();
  const recordOrigPaths = (origs: readonly string[]): void => {
    // plugin.specifier === the original config entry, so look up the name by that entry directly.
    for (const orig of origs) {
      const name = getPluginNameForSpecifier(orig);
      if (name !== undefined && !pluginNameToOrigPath.has(name)) pluginNameToOrigPath.set(name, orig);
    }
  };
  const nameResolves = packageNameResolves(configDir);
  const providerTool = (): Tool => createProviderTool(configPath, providers, pluginNameToOrigPath, nameResolves);

  const { services, makeRunner, loaded } = assembleMachine({
    // The same layout the filesystem storage plugin names: a directory per namespace under `.data`.
    bootBackend:     new FilesystemStorageBackend(dotData),
    preScanned,
    vault:           bootVault,
    providers,
    defaultSettings: config.defaultSettings,
    // Both management tools are in the registry BEFORE any plugin loads, so a plugin that shadows one —
    // persisting `provider` somewhere other than matbot.yaml, say — captures the builtin in setup() and
    // delegates to it, and nothing registered later overwrites the shadow.
    builtinTools:    [createPluginTool(configPath), providerTool()],
    version:         selfVersion(),
    host: machine => ({
      async loadPlugin(specifier: string, prompt?: PromptFn, refresh = false) {
        // refresh re-downloads a changed remote source rather than re-importing the stale cached subtree
        // (the file:// cache-bust only re-evaluates bytes, it can't refetch them). Default off: a
        // programmatic load stays cache-first and offline-tolerant. `plugin reload` opts in.
        const resolved = await resolvePluginSpecifiers([specifier], configDir, refresh);
        // Taken before the import, so it describes the code that ran (see `recordLoaded`).
        const fingerprint = pluginFingerprint(specifier, configDir);
        const plugin   = (await loadPluginsWithDescriptions(resolved, machine(), configDir, /* bustCache */ true, prompt, /* onLoadError */ 'throw'))[0];
        if (plugin === undefined) throw new Error(`No plugin loaded for specifier "${specifier}"`);
        recordLoaded(specifier, fingerprint);
        return plugin;
      },
      async unloadPlugin(specifier: string): Promise<boolean> {
        // A loaded plugin records its config-level specifier (= the matbot.yaml entry) and its canonical
        // name; accept either.
        const name = getPluginNameForSpecifier(specifier)
          ?? (getRegisteredPlugins().some(p => p.name === specifier) ? specifier : undefined);
        if (name === undefined) {
          console.warn(`[matbot] No loaded plugin found for "${specifier}"`);
          return false;
        }
        return unloadPluginFn(name, machine());
      },
      resolver:   nodePluginResolver(configDir),
      workdir:    path.join(dotData, 'bash-cwd'),
      // The CLI's layout: relative specifiers and packages resolve beside matbot.yaml, state lives in
      // `.data` beside it. Plugins are handed both and derive neither.
      projectDir: configDir,
      dataDir:    dotData,
      isSubAgent: () => isBackground,
      TypeScriptStripper: { strip: (source: string) => stripTypeScriptTypes(source) },
    }),
  });

  // Historically loaded provider plugins first so their factories were registered (by plugin name)
  // before any frontend's setup() resolved an adapter. No consumer resolves adapters at setup() now —
  // frontends and the central complete()/singleTurn() all go through instantiateProvider, which
  // force-loads the adapter module on first use, and leaves each profile's `module` exactly as written,
  // so `provider list` reports the source truth.

  recordOrigPaths(providerModules);

  // Not awaited: digests of every configured plugin are not worth holding boot for, and the first reload
  // to need one waits for it.
  const fingerprints = new Map(resolvedPluginMods.map(r => [r.spec, pluginFingerprint(r.spec, configDir)] as const));
  await loadPluginsWithDescriptions(resolvedPluginMods, services, configDir);
  for (const [spec, fingerprint] of fingerprints) {
    if (getPluginNameForSpecifier(spec) !== undefined) recordLoaded(spec, fingerprint);
  }
  loaded();

  // Said once, now that the installed set is known and before anything uses it. A second copy of a host
  // singleton is survivable by design — which is precisely why nothing else would ever mention it — and
  // it is not repaired here: replacing a package-manager-installed directory with a symlink invites the
  // next `install` to undo it. `plugin list` reports the same thing on demand.
  //
  // After the load is early enough, because a plugin's failure does not stop boot and a second copy of the
  // carrier's module shares its state: what a duplicate can actually break is the plugin holding it, whose
  // failure was just logged above this. So a plugin that failed is probed as well, by where it resolved to.
  const failed = new Set(getFailedPlugins().map(f => f.specifier));
  for (const dup of findDuplicateSingletons({
    configDir,
    plugins: [
      ...getRegisteredPlugins(),
      ...resolvedPluginMods.filter(r => failed.has(r.spec)).map(r => ({ name: r.spec, resolvedUrl: r.importSpec })),
    ],
  })) console.warn(`[matbot] ${describeDuplicateSingleton(dup)}`);

  // A provider adapter may be loaded via the plugins list (as a path) rather than a
  // provider config. Record those too, so the provider tool knows the YAML-valid path
  // for every loaded adapter, not just ones already referenced by a provider profile.
  recordOrigPaths(config.plugins);

  // The provider tool's description lists the adapters, which are only known now that every plugin has
  // loaded, so build it again — but only while the registry still holds the BUILTIN. A plugin's tools are
  // stamped with its `pluginName`; the builtin carries none. Registering over a plugin's shadow here would
  // silently undo it: this call goes straight to the registry, past the collision check a plugin's own
  // registration gets, which is exactly what used to happen when the tool was first registered here.
  if (services.tools.resolve('provider')?.pluginName === undefined) services.tools.register(providerTool());

  return { services, makeRunner, providers };
}
