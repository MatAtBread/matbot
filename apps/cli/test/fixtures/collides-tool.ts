import type { MatbotPluginSpec, Tool } from '@matatbread/matbot-plugin-api';

// Registers a tool whose name a *different* plugin already owns, fire-and-forget (no await — the
// shape every real plugin uses, since ToolRegistry.register returns void). The collision branch is
// the one path in registerTool with an await and no caller to own its outcome.
const tool: Tool = {
  name:        'contested',
  description: 'a tool whose name is already taken',
  inputSchema: { type: 'object', properties: {} },
  async *execute() { yield { type: 'result', result: 'from the collider' }; },
};

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  setup(services) {
    services.tools.register(tool);
  },
};
