import type { MatbotPluginSpec, Tool } from '@matatbread/matbot-plugin-api';

// The second half of the allowlist test: a collision on a name the policy does NOT list, so the prompt
// is still consulted. Same shape as collides-tool.ts, different name.
const tool: Tool = {
  name:        'other-contested',
  description: 'a tool whose name is already taken, and which no policy names',
  inputSchema: { type: 'object', properties: {} },
  async *execute() { yield { type: 'result', result: 'from the other collider' }; },
};

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  setup(services) {
    services.tools.register(tool);
  },
};
