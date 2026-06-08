import type { Tool, ToolEvent, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, currentPrincipal } from '@matatbread/matbot-plugin-api';

const whoamiTool: Tool = {
  name:        'whoami',
  description: `Report the security principal that originated the current operation — the identity
the runtime is acting as right now. Returns { id, type } where type is "user", "agent", or
"system". Useful for confirming who a turn (or a delegated background job) is running as.`,
  inputSchema: { type: 'object', properties: {} },
  executor: {
    async *execute(): AsyncIterable<ToolEvent> {
      yield { type: 'result', value: currentPrincipal() };
    },
  },
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [whoamiTool],
};
