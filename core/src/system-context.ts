import type { Session, SystemContextContributor, SystemContextRegistry } from './types.js';

interface TaggedContributor {
  fn:          SystemContextContributor;
  pluginName?: string;
}

export class SystemContextRegistryImpl implements SystemContextRegistry {
  private readonly _contributors: TaggedContributor[] = [];

  register(contributor: SystemContextContributor, pluginName?: string): void {
    this._contributors.push({ fn: contributor, ...(pluginName !== undefined ? { pluginName } : {}) });
  }

  removeByPlugin(pluginName: string): void {
    for (let i = this._contributors.length - 1; i >= 0; i--) {
      if (this._contributors[i]?.pluginName === pluginName) this._contributors.splice(i, 1);
    }
  }

  async build(ctx: { session: Session; signal: AbortSignal }): Promise<string | null> {
    const parts = (await Promise.all(this._contributors.map(c => c.fn(ctx))))
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
}
