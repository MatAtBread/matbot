import { readFile, writeFile } from 'node:fs/promises';
import { classifySpecifier }    from './remote-cache.js';

// The CLI keeps its plugin list in matbot.yaml, and edits it as text so a user's comments and layout survive.

export async function readPluginsList(configPath: string): Promise<string[]> {
  const text  = await readFile(configPath, 'utf8');
  const match = text.match(/^plugins:\s*\n((?:[ \t]+-[^\n]*\n)*)/m);
  if (!match) return [];
  return (match[1] ?? '').split('\n')
    .map(l => l.replace(/^[ \t]+-\s*/, '').trim())
    .filter(Boolean);
}

// False if the specifier is already listed.
export async function addPluginEntry(configPath: string, specifier: string): Promise<boolean> {
  const text  = await readFile(configPath, 'utf8');
  // Match the specifier as a whole list item, not a substring: `- ./plugins/tool-router` must NOT count
  // as already-present just because `- ./plugins/tool-routerx` shares its prefix. The old
  // `text.includes('- ' + specifier)` false-positived on any prefix, silently skipping the write — the
  // plugin then loaded (active in-memory) but never persisted to the config, so it vanished on restart.
  if (new RegExp(`^[ \\t]+-[ \\t]+${escapeRegex(specifier)}[ \\t]*$`, 'm').test(text)) return false;

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
  return true;
}

export async function removePluginEntry(configPath: string, specifier: string): Promise<boolean> {
  const text    = await readFile(configPath, 'utf8');
  const updated = text.replace(new RegExp(`^[ \\t]+-[ \\t]+${escapeRegex(specifier)}\\n`, 'm'), '');
  if (updated === text) return false;
  await writeFile(configPath, updated, 'utf8');
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function readProviderModules(configPath: string): Promise<string[]> {
  const text = await readFile(configPath, 'utf8');
  return [...text.matchAll(/^\s+module:\s+['"]?([^\s'"]+)/gm)].map(m => m[1] ?? '').filter(Boolean);
}

// The configured specifiers, other than `except`, whose files are in the fetched-plugin cache — what
// `releaseRemote` must not delete from under. A provider's `module:` is materialised there as well, and
// counts even when it is the same specifier: removing the plugin does not remove the provider.
export async function otherRemotes(configPath: string, projectDir: string, except: string): Promise<string[]> {
  const plugins = (await readPluginsList(configPath)).filter(spec => spec !== except);
  const remotes: string[] = [];
  for (const spec of new Set([...plugins, ...await readProviderModules(configPath)])) {
    if ((await classifySpecifier(spec, projectDir)).kind === 'http') remotes.push(spec);
  }
  return remotes;
}
