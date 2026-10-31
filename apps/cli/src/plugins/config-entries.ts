import { readFile, writeFile } from 'node:fs/promises';
import { locateSequence, parseYaml, type YamlMap } from '../yaml.js';
import { classifySpecifier }    from './remote-cache.js';

// The CLI keeps its plugin list in matbot.yaml. Reads go through the parser boot uses, so what is reported
// as configured is what loads — the parser, not the whole config's validation, so an incomplete provider
// block does not stop the plugin list being read. Writes edit the text, so a user's comments and layout survive, and then
// parse what they wrote: an edit the parser would read back as anything but the intended list is refused,
// not saved.
//
// Reads were regexes over the text, and disagreed with the parser: a comment line inside the list ended
// it, so `remove` could release cached files an entry below the comment still used; a quoted entry was not
// recognised, so `add` listed it a second time; and an entry with a trailing comment could not be removed.

export async function readPluginsList(configPath: string): Promise<string[]> {
  return pluginsOf(parseYaml(await readFile(configPath, 'utf8')));
}

export async function readProviderModules(configPath: string): Promise<string[]> {
  const providers = parseYaml(await readFile(configPath, 'utf8'))['providers'];
  if (!isMap(providers)) return [];
  return Object.values(providers).flatMap(p => isMap(p) && typeof p['module'] === 'string' ? [p['module']] : []);
}

function pluginsOf(doc: YamlMap): string[] {
  const plugins = doc['plugins'];
  return Array.isArray(plugins) ? plugins.filter(p => typeof p === 'string') : [];
}

function isMap(v: unknown): v is YamlMap {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// False if the specifier is already listed.
export async function addPluginEntry(configPath: string, specifier: string): Promise<boolean> {
  const text   = await readFile(configPath, 'utf8');
  const before = pluginsOf(parseYaml(text));
  if (before.includes(specifier)) return false;

  const lines = text.split('\n');
  const eol   = text.includes('\r\n') ? '\r' : '';
  const list  = locateSequence(text, 'plugins');
  const withItem = (item: string): string => {
    const out = [...lines];
    const firstItem = list?.items[0];
    if (list === undefined) {
      const providers = out.findIndex(l => /^providers\s*:/.test(l));
      out.splice(providers === -1 ? 0 : providers, 0, `plugins:${eol}`, `  - ${item}${eol}`, eol);
    } else if (firstItem !== undefined) {
      const indent = lines[firstItem.line]!.match(/^[ \t]*/)![0];
      out.splice(list.end + 1, 0, `${indent}- ${item}${eol}`);
    } else if (list.inline === '') {
      out.splice(list.keyLine + 1, 0, `  - ${item}${eol}`);
    } else {
      // `plugins: ~` or `plugins: null`, which the parser reads as an empty list.
      out.splice(list.keyLine, 1, `plugins:${eol}`, `  - ${item}${eol}`);
    }
    return out.join('\n');
  };

  // Plain where the parser reads it back as written, quoted where it would not (a `#` after a space, a
  // value it would read as a number, a leading quote).
  const expected = [...before, specifier];
  for (const item of [specifier, `'${specifier}'`, `"${specifier}"`]) {
    const updated = withItem(item);
    if (sameList(pluginsIn(updated), expected)) {
      await writeFile(configPath, updated, 'utf8');
      return true;
    }
  }
  throw new Error(`Could not add "${specifier}" to plugins: in ${configPath} in a form its parser reads back ` +
                  'unchanged. Add it by hand, quoted.');
}

// False if the specifier is not listed. Every entry naming it goes: one left behind loads it again.
export async function removePluginEntry(configPath: string, specifier: string): Promise<boolean> {
  const text   = await readFile(configPath, 'utf8');
  const before = pluginsOf(parseYaml(text));
  const drop   = new Set((locateSequence(text, 'plugins')?.items ?? [])
    .filter(item => item.value === specifier).map(item => item.line));
  if (drop.size === 0) return false;

  const updated = text.split('\n').filter((_, n) => !drop.has(n)).join('\n');
  if (!sameList(pluginsIn(updated), before.filter(s => s !== specifier))) {
    throw new Error(`Could not remove "${specifier}" from plugins: in ${configPath} without changing how the ` +
                    'rest of the file reads. Remove it by hand.');
  }
  await writeFile(configPath, updated, 'utf8');
  return true;
}

function pluginsIn(text: string): readonly string[] | undefined {
  try { return pluginsOf(parseYaml(text)); } catch { return undefined; }
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((s, i) => s === b[i]);
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
