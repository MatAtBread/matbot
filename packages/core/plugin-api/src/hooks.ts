import type { Hook, HookContext, HookPoint } from './types.js';

export class HookRegistry {
  private readonly hooks = new Map<HookPoint, Hook[]>();

  register(hook: Hook): this {
    const list = this.hooks.get(hook.point) ?? [];
    list.push(hook);
    list.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    this.hooks.set(hook.point, list);
    return this;
  }

  async run(point: HookPoint, ctx: HookContext): Promise<HookContext> {
    const list = this.hooks.get(point) ?? [];
    let current = ctx;
    for (const hook of list) {
      if (current.abort) break;
      const result = await hook.handler(current);
      if (result !== undefined) current = result;
    }
    return current;
  }
}
