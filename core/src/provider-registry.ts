import type { ProviderConfig, ProviderRegistry } from '@matatbread/matbot-plugin-api';

/**
 * A `Map` of provider profiles that also satisfies the sanctioned {@link ProviderRegistry} write API.
 * Extending `Map` gives every read-surface consumer (`get`/`has`/`keys`/`values`/iteration) the exact
 * standard-library types, while `register`/`remove` are the names plugins and the `provider` tool use
 * to contribute profiles — mirroring `ToolRegistry.register`/`remove`.
 */
export class ProviderRegistryImpl extends Map<string, ProviderConfig> implements ProviderRegistry {
  register(config: ProviderConfig): void { this.set(config.name, config); }
  remove(name: string): boolean { return this.delete(name); }
}
