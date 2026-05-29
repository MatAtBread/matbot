import type { Hook, HookContext, HookPoint } from './types.js';

export class HookRegistry {
  private readonly hooks = new Map<HookPoint, Hook[]>();

  register(hook: Hook): void {
    const list = this.hooks.get(hook.point) ?? [];
    list.push(hook);
    list.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    this.hooks.set(hook.point, list);
  }

  removeByPlugin(pluginName: string): void {
    for (const [point, list] of this.hooks) {
      this.hooks.set(point, list.filter(h => h.pluginName !== pluginName));
    }
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
