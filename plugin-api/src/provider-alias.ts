import type { ProviderAlias, ProviderConfig, ProviderEntry } from './types/provider.js';
import { withFailure } from './errors.js';

export function isProviderAlias(entry: ProviderEntry): entry is ProviderAlias {
  return 'alias' in entry;
}

/** The aliases that point at `target`, in registry order. */
export function aliasesOf(entries: ReadonlyMap<string, ProviderEntry>, target: string): string[] {
  const out: string[] = [];
  for (const e of entries.values()) if (isProviderAlias(e) && e.alias === target) out.push(e.name);
  return out;
}

/**
 * Why `entry` cannot be stored in `entries` (replacing whatever has its name), or `undefined` if it can.
 * Every writer — the registry, a host's persisted map, the `provider` tools — asks this one question, so
 * the one-hop rule is said once: an alias's target is a profile, and a name aliases point at stays one.
 */
export function aliasProblem(entries: ReadonlyMap<string, ProviderEntry>, entry: ProviderEntry): string | undefined {
  if (isProviderAlias(entry)) {
    if (entry.alias === entry.name) return `"${entry.name}" cannot be an alias of itself.`;
    const target = entries.get(entry.alias);
    if (target === undefined) return `"${entry.name}" cannot be an alias of "${entry.alias}": no provider of that name is configured.`;
    if (isProviderAlias(target))
      return `"${entry.name}" cannot be an alias of "${entry.alias}", which is itself an alias (of "${target.alias}"). Point it at "${target.alias}".`;
    const pointing = aliasesOf(entries, entry.name);
    if (pointing.length > 0)
      return `"${entry.name}" cannot become an alias: ${quoted(pointing)} ${pointing.length === 1 ? 'points' : 'point'} at it. Repoint ${pointing.length === 1 ? 'it' : 'them'} first.`;
  }
  return undefined;
}

/** Why `name` cannot be removed from `entries`, or `undefined` if it can. */
export function removalProblem(entries: ReadonlyMap<string, ProviderEntry>, name: string): string | undefined {
  const pointing = aliasesOf(entries, name);
  return pointing.length === 0 ? undefined
    : `"${name}" cannot be removed: ${quoted(pointing)} ${pointing.length === 1 ? 'is an alias' : 'are aliases'} of it. Repoint or remove ${pointing.length === 1 ? 'it' : 'them'} first.`;
}

/** The profile `name` runs on — see `ProviderRegistry.resolve`. */
export function resolveProviderEntry(entries: ReadonlyMap<string, ProviderEntry>, name: string): ProviderConfig | undefined {
  const entry = entries.get(name);
  if (entry === undefined || !isProviderAlias(entry)) return entry;
  const target = entries.get(entry.alias);
  if (target === undefined || isProviderAlias(target))
    throw withFailure(new Error(`Provider "${name}" is an alias of "${entry.alias}", which is not a configured provider profile.`), 'invalid');
  return target;
}

/** `name`, or `name → target` for an alias: how a list a model reads names a provider, so it can see
 *  that a role name exists and what it currently runs on. */
export function describeProvider(entry: ProviderEntry): string {
  return isProviderAlias(entry) ? `${entry.name} → ${entry.alias}` : entry.name;
}

/** Every configured provider, as {@link describeProvider} names them, comma-separated. */
export function describeProviders(entries: ReadonlyMap<string, ProviderEntry>): string {
  return [...entries.values()].map(describeProvider).join(', ');
}

function quoted(names: readonly string[]): string {
  return names.map(n => `"${n}"`).join(', ');
}
