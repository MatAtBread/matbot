import type { Tool, ToolEvent, ToolContext, MatbotPlugin } from '@matatbread/matbot-plugin-api';
import { getRegisteredPlugins }              from '@matatbread/matbot-core';
import { readFile, writeFile, access }       from 'node:fs/promises';
import { spawn }                             from 'node:child_process';
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

function pluginTypes(p: MatbotPlugin): string[] {
  const t: string[] = [];
  if (p.tools?.length)                            t.push('tools');
  if (Object.keys(p.providers ?? {}).length)      t.push('provider');
  if (Object.keys(p.storage   ?? {}).length)      t.push('storage');
  if (p.frontend !== undefined)                   t.push('frontend');
  if (!t.length)                                  t.push('extension');
  return t;
}

// ── Input types ───────────────────────────────────────────────────────────────

type PluginInput =
  | { action: 'list' }
  | { action: 'add';    specifier: string }
  | { action: 'remove'; specifier: string };

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
      const loaded     = getRegisteredPlugins().map(p => ({
        name:       p.name,
        apiVersion: p.apiVersion,
        types:      pluginTypes(p),
      }));
      yield {
        type:  'result',
        value: { loaded, configured },
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
        await ctx.loadPlugin(specifier);
        yield { type: 'result', value: { message: `"${specifier}" installed and is now active.` } };
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

      yield { type: 'result', value: { message: `"${specifier}" removed from config.` } };
    }
  },
};

// ── Tool definition ───────────────────────────────────────────────────────────

export const pluginTool: Tool = {
  name:        'plugin',
  description: 'Manage matbot plugins: list configured plugins, add a new one, or remove an existing one.',
  requires:    ['filesystem', 'spawn'],
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action: {
        type:        'string',
        enum:        ['list', 'add', 'remove'],
        description: 'list: show configured plugins. add: install and register a plugin. remove: deregister and optionally uninstall.',
      },
      specifier: {
        type:        'string',
        description: 'npm package name, file path, or GitHub shorthand (required for add/remove).',
      },
    },
  },
  executor,
};
