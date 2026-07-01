import type { ProviderConfig, ProviderRegistry } from '@matatbread/matbot-plugin-api';

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
export class ProviderRegistryImpl extends Map<string, ProviderConfig> implements ProviderRegistry {
  private readonly bootBaseline: Map<string, ProviderConfig>;

  constructor(initial?: Iterable<readonly [string, ProviderConfig]>) {
    super(initial);
    this.bootBaseline = new Map(this);
  }

  register(config: ProviderConfig): void { this.set(config.name, config); }
  remove(name: string): boolean { return this.delete(name); }

  revert(name: string): void {
    const boot = this.bootBaseline.get(name);
    if (boot !== undefined) this.set(name, boot);
    else this.delete(name);
  }
}
