import type { ProviderConfig, ProviderEntry, ProviderRegistry } from '@matatbread/matbot-plugin-api';
import { aliasProblem, isProviderAlias, removalProblem, resolveProviderEntry } from '@matatbread/matbot-plugin-api';

/**
 * A `Map` of provider profiles that also satisfies the sanctioned {@link ProviderRegistry} write API.
 * Extending `Map` gives every read-surface consumer (`get`/`has`/`keys`/`values`/iteration) the exact
 * standard-library types, while `register`/`remove`/`revert` are the names plugins and the `provider`
 * tool use to contribute profiles — mirroring `ToolRegistry.register`/`remove`.
 *
 * The entries present at construction are snapshotted as the *boot baseline*: `revert(name)` restores
 * that value (or deletes if there was none), so a plugin that contributed — possibly shadowing — a
 * profile can undo it on unload, returning the set to the host's boot condition.
 */
export class ProviderRegistryImpl extends Map<string, ProviderEntry> implements ProviderRegistry {
  private readonly bootBaseline: Map<string, ProviderEntry>;

  // Checked once the whole set is in, so an alias written above its target in a config is not an error.
  constructor(initial?: Iterable<readonly [string, ProviderEntry]>) {
    super(initial);
    for (const e of this.values()) {
      const problem = isProviderAlias(e) ? aliasProblem(this, e) : undefined;
      if (problem !== undefined) throw new Error(`Provider alias: ${problem}`);
    }
    this.bootBaseline = new Map(this);
  }

  register(entry: ProviderEntry): void {
    const problem = aliasProblem(this, entry);
    if (problem !== undefined) throw new Error(problem);
    this.set(entry.name, entry);
  }

  remove(name: string): boolean {
    const problem = removalProblem(this, name);
    if (problem !== undefined) throw new Error(problem);
    return this.delete(name);
  }

  resolve(name: string): ProviderConfig | undefined {
    return resolveProviderEntry(this, name);
  }

  // Never refuses: it runs at a plugin's unload, which must complete. An alias it leaves without a
  // target is reported by `resolve`, at the first call that uses it.
  revert(name: string): void {
    const boot = this.bootBaseline.get(name);
    if (boot !== undefined) this.set(name, boot);
    else this.delete(name);
  }
}
