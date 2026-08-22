import type { Session, SystemContextContributor, SystemContextPart, SystemContextRegistry } from './types.js';

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

  async parts(ctx: { session: Session; signal: AbortSignal }): Promise<SystemContextPart[]> {
    const texts = await Promise.all(this._contributors.map(c => c.fn(ctx)));
    return this._contributors.flatMap((c, i) => {
      const text = texts[i];
      if (typeof text !== 'string' || text.length === 0) return [];
      return [{ text, ...(c.pluginName !== undefined ? { plugin: c.pluginName } : {}) }];
    });
  }

  // The joined form is derived from the attributed one, so the prompt the model receives and the
  // breakdown `about_matbot` reports cannot drift: there is one traversal and one filter.
  async build(ctx: { session: Session; signal: AbortSignal }): Promise<string | null> {
    const parts = await this.parts(ctx);
    return parts.length > 0 ? parts.map(p => p.text).join('\n\n') : null;
  }
}
