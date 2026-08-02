import { RegistryChangeKind } from '@matatbread/matbot-plugin-api';
import type { Tool, ToolRegistry, Notifier } from './types.js';

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  // The host's notifier proxy, injected at boot (both hosts build it before this registry). Held as the
  // proxy, not a resolved impl, so a later register('Notifier', …) takes effect here too. Optional: a
  // registry built without one (tests) simply announces nothing.
  private readonly notifier: Notifier | undefined;

  constructor(initial?: Iterable<Tool>, notifier?: Notifier) {
    if (initial !== undefined) for (const tool of initial) this.tools.set(tool.name, tool);
    this.notifier = notifier;
  }

  private announce(name: string, operation: 'added' | 'removed', pluginName?: string): void {
    this.notifier?.notify({
      kind: RegistryChangeKind, source: 'tools', registry: 'tools', name, operation,
      ...(pluginName !== undefined ? { detail: { pluginName } } : {}),
    });
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.announce(tool.name, 'added', tool.pluginName);
  }

  remove(name: string): void {
    if (this.tools.delete(name)) this.announce(name, 'removed');
  }

  removeByPlugin(pluginName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === pluginName && this.tools.delete(name)) this.announce(name, 'removed');
    }
  }

  resolve(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}
