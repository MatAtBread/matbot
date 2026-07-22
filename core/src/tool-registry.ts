import type { Tool, ToolRegistry, ToolRegistryEvent } from './types.js';
import { createBroadcaster } from '@matatbread/matbot-plugin-api';

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly events = createBroadcaster<ToolRegistryEvent>();

  constructor(initial?: Iterable<Tool>) {
    if (initial !== undefined) for (const tool of initial) this.tools.set(tool.name, tool);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.events.emit({ type: 'registered', name: tool.name, ...(tool.pluginName !== undefined ? { pluginName: tool.pluginName } : {}) });
  }

  remove(name: string): void {
    if (this.tools.delete(name)) this.events.emit({ type: 'removed', name });
  }

  removeByPlugin(pluginName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === pluginName && this.tools.delete(name)) this.events.emit({ type: 'removed', name });
    }
  }

  resolve(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async *watch(signal?: AbortSignal): AsyncIterable<ToolRegistryEvent> {
    // Tool CRUD is global — no origin — so unwrap the envelope to the bare event.
    for await (const { value } of this.events.subscribe(signal)) yield value;
  }
}
