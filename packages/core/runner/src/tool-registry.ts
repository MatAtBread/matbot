import type { Tool, ToolRegistry } from './types.js';

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  remove(name: string): void {
    this.tools.delete(name);
  }

  removeByPlugin(pluginName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === pluginName) this.tools.delete(name);
    }
  }

  resolve(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}
