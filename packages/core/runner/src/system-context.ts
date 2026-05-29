import type { Session, Principal, SystemContextContributor, SystemContextRegistry } from './types.js';

export class SystemContextRegistryImpl implements SystemContextRegistry {
  private readonly _contributors: SystemContextContributor[] = [];

  register(contributor: SystemContextContributor): void {
    this._contributors.push(contributor);
  }

  async build(ctx: { session: Session; principal: Principal; signal: AbortSignal }): Promise<string | null> {
    const parts = (await Promise.all(this._contributors.map(c => c(ctx))))
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
}
