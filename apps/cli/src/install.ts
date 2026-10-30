import { readFile, writeFile }          from 'node:fs/promises';
import { spawn }                        from 'node:child_process';
import path                             from 'node:path';
import process                          from 'node:process';
import type { MatbotPlugin }            from '@matatbread/matbot-core';
import { backfillPluginDescription }    from './plugin-description.js';
import { addFlags, declaredDependencies, detectPackageManager, isPackageName, writeInstallRecord } from '@matatbread/matbot-tool-plugin';

// ── Shell runner ───────────────────────��───────────────────────────────���──────

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${String(code)}`));
    });
  });
}

// ── matbot.yaml updater ──────────────────────────��────────────────────────────

async function addToPluginsList(configPath: string, specifier: string): Promise<void> {
  const text = await readFile(configPath, 'utf8');

  // Check if this specifier is already listed
  if (text.includes(`- ${specifier}`)) {
    process.stderr.write(`"${specifier}" is already in plugins list.\n`);
    return;
  }

  let updated: string;
  const pluginsBlockMatch = text.match(/^(plugins:\s*\n(?:[ \t]+-[^\n]*\n)*)/m);

  if (pluginsBlockMatch) {
    const insertAt = pluginsBlockMatch.index! + pluginsBlockMatch[0].length;
    updated = text.slice(0, insertAt) + `  - ${specifier}\n` + text.slice(insertAt);
  } else {
    // Insert a new plugins: section before providers: (or at the top)
    const providersIdx = text.indexOf('\nproviders:');
    if (providersIdx !== -1) {
      updated = text.slice(0, providersIdx) + `\nplugins:\n  - ${specifier}\n` + text.slice(providersIdx);
    } else {
      updated = `plugins:\n  - ${specifier}\n\n` + text;
    }
  }

  await writeFile(configPath, updated, 'utf8');
}

// ── Main install flow ─────────────────────���─────────────────────────────────��─

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
  await addToPluginsList(configPath, specifier);
  process.stderr.write(`Added "${specifier}" to plugins in ${path.basename(configPath)}\n`);
  // The same record `plugin add` writes, so `plugin remove` can offer to take back what this installed.
  if (dependency !== undefined) await writeInstallRecord(path.join(projectDir, '.plugins'), { entry: specifier, dependency });

  // Secrets a plugin needs are gathered lazily on first use: the plugin raises
  // MissingSecretError naming the key, and the model supplies it via `plugin store-key`.
  process.stderr.write(`\nPlugin installed.\n`);
}
