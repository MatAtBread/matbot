import type { MatbotPluginSpec, Tool } from '@matatbread/matbot-plugin-api';

// A second plugin claiming the SAME name as collides-tool.ts, so one process can observe a per-tool
// "always overwrite" answer applying to the next collision on that name.
const tool: Tool = {
  name:        'contested',
  description: 'a tool whose name is already taken, twice over',
  inputSchema: { type: 'object', properties: {} },
  async *execute() { yield { type: 'result', result: 'from the twin' }; },
};

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  setup(services) {
    services.tools.register(tool);
  },
};
