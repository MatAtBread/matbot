import { spawn }                        from 'node:child_process';
import path                             from 'node:path';
import process                          from 'node:process';
import type { MatbotPlugin }            from '@matatbread/matbot-core';
import { backfillPluginDescription }    from '@matatbread/matbot-host-node';
import { declaredDependencies, isPackageName, writeInstallRecord } from './plugins/install-record.js';
import { addFlags, detectPackageManager } from './plugins/package-manager.js';
import { addPluginEntry }  from './plugins/config-entries.js';
import { findUp }          from './config.js';
import { yellow }          from './terminal.js';

// ── Shell runner ─────────────────────────────────────────────────────────────

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${String(code)}`));
    });
  });
}

// ── Main install flow ────────────────────────────────────────────────────────

export async function installPlugin(specifier: string, configPath: string): Promise<void> {
  const projectDir = path.dirname(configPath);

  // 1. Install via package manager (skip for local paths — already on disk)
  const isLocalPath = specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier);
  let dependency: string | undefined;
  if (!isLocalPath) {
    // `plugin add`'s rule: a plugin by its package name, so the key the package manager writes is that name and
    // what is recorded is what was seen to change. A declared one is the project's, at the version it chose.
    if (!isPackageName(specifier)) {
      throw new Error(`"${specifier}" is not a package name. Install a version, a tarball or a git package with your ` +
                      `package manager, then \`matbot install <its name>\`.`);
    }
    const before = await declaredDependencies(projectDir);
    if (before?.has(specifier) !== true) {
      const pm = await detectPackageManager(projectDir);
      process.stderr.write(`\nInstalling "${specifier}" with ${pm}...\n`);
      await runCommand(pm, ['add', ...await addFlags(pm, projectDir), specifier], projectDir);
      if (before !== undefined && (await declaredDependencies(projectDir))?.has(specifier) === true) dependency = specifier;
    }
  }

  // 2. Inspect the plugin manifest
  let plugin: MatbotPlugin | undefined;
  try {
    const mod = await import(specifier) as Record<string, unknown>;
    plugin = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
  } catch {
    process.stderr.write(`[warn] Could not import "${specifier}" to inspect its manifest.\n`);
  }

  if (plugin !== undefined) await backfillPluginDescription(plugin, specifier, projectDir);

  if (plugin?.manifest?.description) {
    process.stderr.write(`\n${plugin.manifest.description}\n`);
  }

  // 3. Update matbot.yaml
  if (await addPluginEntry(configPath, specifier)) {
    process.stderr.write(`Added "${specifier}" to plugins in ${path.basename(configPath)}\n`);
  } else {
    process.stderr.write(`"${specifier}" is already in plugins list.\n`);
  }
  // The same record `plugin add` writes, so `plugin remove` can offer to take back what this installed.
  if (dependency !== undefined) await writeInstallRecord(path.join(projectDir, '.plugins'), { entry: specifier, dependency });

  // Secrets a plugin needs are gathered lazily on first use: the plugin raises
  // MissingSecretError naming the key, and the model supplies it via `plugin store-key`.
  process.stderr.write(`\nPlugin installed.\n`);
}

/** `matbot install <package> [--config <path>]`. */
export async function installCommand(args: readonly string[]): Promise<void> {
  const specifier = args.find(a => !a.startsWith('-'));
  if (!specifier) {
    process.stderr.write(yellow('Usage: matbot install <package>\n'));
    process.exit(1);
  }
  const configFlag = args.indexOf('--config');
  const configArg  = configFlag !== -1 ? args[configFlag + 1] : undefined;
  const configPath = configArg !== undefined
    ? path.resolve(configArg)
    : (await findUp('matbot.yaml')) ?? path.resolve('matbot.yaml');
  await installPlugin(specifier, configPath);
}
