import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn }                        from 'node:child_process';
import { createInterface }              from 'node:readline/promises';
import path                             from 'node:path';
import process                          from 'node:process';
import type { MatbotPlugin }            from '@matatbread/matbot-core';

// ── Package manager detection ───────────────────────��─────────────────────────

async function detectPackageManager(dir: string): Promise<string> {
  for (const [pm, lockfile] of [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lockb']] as const) {
    try { await access(path.join(dir, lockfile)); return pm; } catch { /* not present */ }
  }
  return 'npm';
}

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

// ── .env writer ──────────────────────────��──────────────────────────���─────────

async function appendEnvVar(envPath: string, key: string, value: string): Promise<void> {
  let existing = '';
  try { existing = await readFile(envPath, 'utf8'); } catch { /* file may not exist yet */ }
  if (existing.includes(`${key}=`)) return;  // already set
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(envPath, `${existing}${separator}${key}=${value}\n`, 'utf8');
}

// ── Main install flow ─────────────────────���─────────────────────────────────��─

export async function installPlugin(specifier: string, configPath: string): Promise<void> {
  const projectDir = path.dirname(configPath);
  const envPath    = path.join(projectDir, '.env');

  // 1. Install via package manager (skip for local paths — already on disk)
  const isLocalPath = specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier);
  if (!isLocalPath) {
    const pm = await detectPackageManager(projectDir);
    process.stderr.write(`\nInstalling "${specifier}" with ${pm}...\n`);
    await runCommand(pm, ['add', specifier], projectDir);
  }

  // 2. Inspect the plugin manifest
  let plugin: MatbotPlugin | undefined;
  try {
    const mod = await import(specifier) as Record<string, unknown>;
    plugin = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
  } catch {
    process.stderr.write(`[warn] Could not import "${specifier}" to inspect its manifest.\n`);
  }

  if (plugin?.manifest?.description) {
    process.stderr.write(`\n${plugin.manifest.description}\n`);
  }

  // 3. Update matbot.yaml
  await addToPluginsList(configPath, specifier);
  process.stderr.write(`Added "${specifier}" to plugins in ${path.basename(configPath)}\n`);

  // 4. Prompt for any required credentials not yet in the environment
  const needed = plugin?.manifest?.credentials ?? [];
  if (needed.length > 0) {
    const missing = needed.filter((k: string) => !process.env[k]);
    if (missing.length > 0) {
      process.stderr.write(`\nThis plugin requires the following environment variables:\n`);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      for (const key of missing) {
        const value = await rl.question(`  ${key}: `);
        if (value.trim()) {
          await appendEnvVar(envPath, key, value.trim());
          process.stderr.write(`  → written to ${path.basename(envPath)}\n`);
        }
      }
      rl.close();
    }
  }

  process.stderr.write(`\nPlugin installed.\n`);
}
