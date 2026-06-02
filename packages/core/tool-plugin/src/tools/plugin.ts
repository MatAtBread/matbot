import type { Tool, ToolEvent, ToolContext, MatbotPlugin } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins, getRegisteredTools, getRegisteredFrontendPlugins } from '@matatbread/matbot-core';
import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import { spawn }                             from 'node:child_process';
import { pathToFileURL }                     from 'node:url';
import path                                  from 'node:path';
import process                               from 'node:process';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readPluginsList(configPath: string): Promise<string[]> {
  const text  = await readFile(configPath, 'utf8');
  const match = text.match(/^plugins:\s*\n((?:[ \t]+-[^\n]*\n)*)/m);
  if (!match) return [];
  return (match[1] ?? '').split('\n')
    .map(l => l.replace(/^[ \t]+-\s*/, '').trim())
    .filter(Boolean);
}

async function addPlugin(configPath: string, specifier: string): Promise<void> {
  const text  = await readFile(configPath, 'utf8');
  if (text.includes(`- ${specifier}`)) return;

  let updated: string;
  const blockMatch = text.match(/^(plugins:\s*\n(?:[ \t]+-[^\n]*\n)*)/m);
  if (blockMatch) {
    const at = blockMatch.index! + blockMatch[0].length;
    updated  = text.slice(0, at) + `  - ${specifier}\n` + text.slice(at);
  } else {
    const pi = text.indexOf('\nproviders:');
    updated  = pi !== -1
      ? text.slice(0, pi) + `\nplugins:\n  - ${specifier}\n` + text.slice(pi)
      : `plugins:\n  - ${specifier}\n\n` + text;
  }
  await writeFile(configPath, updated, 'utf8');
}

async function removePlugin(configPath: string, specifier: string): Promise<boolean> {
  const text    = await readFile(configPath, 'utf8');
  const updated = text.replace(new RegExp(`^[ \\t]+-[ \\t]+${escapeRegex(specifier)}\\n`, 'm'), '');
  if (updated === text) return false;
  await writeFile(configPath, updated, 'utf8');
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveExportsMain(exports: unknown): string | undefined {
  if (typeof exports === 'string') return exports;
  if (exports !== null && typeof exports === 'object') {
    const dot = (exports as Record<string, unknown>)['.'];
    if (typeof dot === 'string') return dot;
  }
  return undefined;
}

// TODO: This is a convenience shim for end users in monorepo setups and is
// intentionally narrow. It should eventually be replaced with a proper
// discovery interface — registry lookup, repo scanning, or a plugin marketplace.
async function discoverLocalPlugins(
  projectDir: string,
): Promise<Array<{ specifier: string; name: string; description: string }>> {
  const pluginsDir = path.join(projectDir, 'packages', 'plugins');
  try { await access(pluginsDir); } catch { return []; }

  const results: Array<{ specifier: string; name: string; description: string }> = [];

  const scan = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      try {
        const pkg = JSON.parse(await readFile(path.join(sub, 'package.json'), 'utf8')) as {
          name?: string;
          description?: string;
          dependencies?: Record<string, string>;
        };
        if (pkg.dependencies?.['@matatbread/matbot-plugin-api'] !== undefined) {
          // Prefer manifest.description (runtime source of truth) over package.json description.
          let description = pkg.description ?? '';
          // Resolve the explicit entry file from exports["."] so we import the .ts file
          // directly rather than the directory (directory import requires the loader to
          // handle exports-field resolution for .ts files, which is unreliable).
          const exportsMain = resolveExportsMain((pkg as { exports?: unknown }).exports);
          if (exportsMain) {
            try {
              const entryUrl = pathToFileURL(path.join(sub, exportsMain)).href;
              const mod = await import(entryUrl) as Record<string, unknown>;
              const p = (mod['plugin'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['plugin']) as MatbotPlugin | undefined;
              if (p?.manifest?.description) description = p.manifest.description;
            } catch { /* leave description as-is */ }
          }

          results.push({
            specifier:   `./${path.relative(projectDir, sub).replace(/\\/g, '/')}`,
            name:        pkg.name ?? entry.name,
            description,
          });
        }
      } catch { /* no package.json or unreadable */ }
      if (depth < 2) await scan(sub, depth + 1);
    }
  };

  await scan(pluginsDir, 1);
  return results;
}

async function readProviderModules(configPath: string): Promise<string[]> {
  const text = await readFile(configPath, 'utf8');
  return [...text.matchAll(/^\s+module:\s+(\S+)/gm)].map(m => m[1] ?? '').filter(Boolean);
}

async function detectPackageManager(dir: string): Promise<string> {
  for (const [pm, lockfile] of [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lockb']] as const) {
    try { await access(path.join(dir, lockfile)); return pm; } catch { /* not present */ }
  }
  return 'npm';
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32' });
    child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.on('close', code => {
      if (code === 0) resolve(chunks.join(''));
      else reject(new Error(`${cmd} exited with code ${String(code)}\n${chunks.join('')}`));
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pluginTypes(p: MatbotPlugin, registeredToolPlugins: Set<string>): string[] {
  const t: string[] = [];
  if (p.tools?.length || registeredToolPlugins.has(p.name))                 t.push('tools');
  if (p.provider !== undefined)                                              t.push('provider');
  if (Object.keys(p.storage   ?? {}).length)                                t.push('storage');
  if (p.frontend !== undefined || getRegisteredFrontendPlugins().has(p.name)) t.push('frontend');
  if (!t.length)                                                            t.push('extension');
  return t;
}

// ── Input types ───────────────────────────────────────────────────────────────

type PluginInput =
  | { action: 'list' }
  | { action: 'add';            specifier: string }
  | { action: 'remove';         specifier: string }
  | { action: 'reload';         specifier: string }
  | { action: 'discover_local' };

// ── Executor ──────────────────────────────────────────────────────────────────

const executor = {
  async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const { action } = input as PluginInput;

    const configPath = ctx.configPath;
    if (!configPath) {
      yield { type: 'error', message: 'No config path in tool context — cannot manage plugins.' };
      return;
    }
    const projectDir = path.dirname(configPath);

    // ── list ─────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const configured = await readPluginsList(configPath);
      const allTools   = getRegisteredTools();

      // Group tool names by owning plugin (undefined = built-in / unattributed)
      const toolsByPlugin = new Map<string | undefined, string[]>();
      for (const t of allTools) {
        const key  = t.pluginName;
        const list = toolsByPlugin.get(key) ?? [];
        list.push(t.name);
        toolsByPlugin.set(key, list);
      }

      const pluginToolNames = new Set(
        [...toolsByPlugin.keys()].filter((k): k is string => k !== undefined),
      );

      const loaded = getRegisteredPlugins().map(p => ({
        name:        p.name,
        apiVersion:  p.apiVersion,
        types:       pluginTypes(p, pluginToolNames),
        tools:       toolsByPlugin.get(p.name) ?? [],
        ...(p.manifest?.description ? { description: p.manifest.description } : {}),
      }));

      yield {
        type:  'result',
        value: {
          loaded,
          configured,
          ...(toolsByPlugin.has(undefined) ? { builtinTools: toolsByPlugin.get(undefined) } : {}),
        },
      };
      return;
    }

    // ── discover_local ────────────────────────────────────────────────────────
    if (action === 'discover_local') {
      const found           = await discoverLocalPlugins(projectDir);
      const pluginEntries   = new Set(await readPluginsList(configPath));
      const providerModules = new Set(await readProviderModules(configPath));
      yield {
        type:  'result',
        value: found.map(p => ({
          ...p,
          configuredVia: pluginEntries.has(p.specifier) ? 'plugins'
                       : providerModules.has(p.specifier) ? 'providers'
                       : null,
        })),
      };
      return;
    }

    const { specifier } = input as { action: string; specifier: string };

    // ── add ──────────────────────────────────────────────────────────────────
    if (action === 'add') {
      const existing = await readPluginsList(configPath);
      if (existing.includes(specifier)) {
        yield { type: 'result', value: { message: `"${specifier}" is already configured.` } };
        return;
      }

      // ctx.prompt rather than a `confirmed` input parameter: plugin installation is a
      // privileged operation. Breaking the LLM's execution chain and requiring an
      // out-of-band human response prevents prompt injection or a malicious plugin
      // from auto-installing further plugins by simply passing confirmed:true.
      const confirm = await ctx.prompt(`Install plugin "${specifier}"? [y/N]`, 'N');
      if (!/^y(es)?$/i.test(confirm.trim())) {
        yield { type: 'result', value: { message: 'Cancelled.' } };
        return;
      }

      const isLocalPath = specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier);
      if (!isLocalPath) {
        const pm = await detectPackageManager(projectDir);
        yield { type: 'stdout', chunk: `Installing "${specifier}" with ${pm}...\n` };
        try {
          const out = await runCommand(pm, ['add', specifier], projectDir);
          if (out) yield { type: 'stdout', chunk: out };
        } catch (e) {
          yield { type: 'error', message: String(e) };
          return;
        }
      }

      await addPlugin(configPath, specifier);

      yield { type: 'stdout', chunk: `Activating "${specifier}"...\n` };
      try {
        const loaded  = await ctx.loadPlugin(specifier);
        const welcome = await loaded.installationMessage?.();
        yield {
          type:  'result',
          value: {
            message: `"${specifier}" installed and is now active.`,
            ...(welcome !== undefined ? { installationMessage: welcome } : {}),
          },
        };
      } catch (e) {
        yield { type: 'result', value: { message: `"${specifier}" added to config but activation failed: ${String(e)}.` } };
      }
      return;
    }

    // ── remove ───────────────────────────────────────────────────────────────
    if (action === 'remove') {
      const existing = await readPluginsList(configPath);
      if (!existing.includes(specifier)) {
        yield { type: 'result', value: { message: `"${specifier}" is not in the plugins list.` } };
        return;
      }

      // Same security rationale as add: out-of-band prompt, not a confirmable parameter.
      const confirm = await ctx.prompt(`Remove plugin "${specifier}"? [y/N]`, 'N');
      if (!/^y(es)?$/i.test(confirm.trim())) {
        yield { type: 'result', value: { message: 'Cancelled.' } };
        return;
      }

      const removed = await removePlugin(configPath, specifier);
      if (!removed) {
        yield { type: 'error', message: `Failed to remove "${specifier}" from ${path.basename(configPath)}.` };
        return;
      }

      yield { type: 'stdout', chunk: `Deactivating "${specifier}"...\n` };
      try {
        await ctx.unloadPlugin(specifier);
      } catch (e) {
        yield { type: 'stderr', chunk: `Deactivation failed: ${String(e)}\n` };
      }

      const uninstall = await ctx.prompt(`Also uninstall the npm package? [y/N]`, 'N');
      if (/^y(es)?$/i.test(uninstall.trim())) {
        const pm = await detectPackageManager(projectDir);
        try {
          const out = await runCommand(pm, ['remove', specifier], projectDir);
          if (out) yield { type: 'stdout', chunk: out };
        } catch (e) {
          yield { type: 'stderr', chunk: `Uninstall failed: ${String(e)}\n` };
        }
      }

      yield { type: 'result', value: { message: `"${specifier}" removed and deactivated.` } };
    }

    // ── reload ────────────────────────────────────────────────────────────────
    if (action === 'reload') {
      yield { type: 'stdout', chunk: `Reloading "${specifier}"...\n` };

      try {
        await ctx.unloadPlugin(specifier);
      } catch (e) {
        yield { type: 'stderr', chunk: `Unload phase failed: ${String(e)}\n` };
      }

      try {
        await ctx.loadPlugin(specifier);
        yield { type: 'result', value: { message: `"${specifier}" reloaded successfully.` } };
      } catch (e) {
        yield { type: 'error', message: `Reload failed during load phase: ${String(e)}` };
      }
    }
  },
};

// ── Tool definition ───────────────────────────────────────────────────────────

export const pluginTool: Tool = {
  name:        'plugin',
  description: 'Manage matbot plugins: list configured plugins, add a new one, remove an existing one, reload one from disk, or discover available local plugins.',
  requires:    ['filesystem', 'spawn'],
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action: {
        type:        'string',
        enum:        ['list', 'add', 'remove', 'reload', 'discover_local'],
        description: 'list: show configured plugins. add: install and register a plugin. remove: deregister and optionally uninstall. reload: unload and re-import from disk (picks up code changes without restarting). discover_local: scan packages/plugins for available local plugins.',
      },
      specifier: {
        type:        'string',
        description: 'npm package name, file path, or GitHub shorthand (required for add/remove).',
      },
    },
  },
  executor,
};
