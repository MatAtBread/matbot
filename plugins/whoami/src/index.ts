import type { Tool, ToolResultOf, Principal, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, currentPrincipal } from '@matatbread/matbot-plugin-api';

declare module '@matatbread/matbot-plugin-api' {
  interface ToolResults {
    whoami: Principal;
  }
}

const whoamiTool: Tool<ToolResultOf<'whoami'>> = {
  name:        'whoami',
  description: `Report the security principal that originated the current operation — the identity
the runtime is acting as right now. Returns { id, type } where type is "user", "agent", or
"system". Useful for confirming who a turn (or a delegated background job) is running as.`,
  inputSchema: { type: 'object', properties: {} },
  executor: {
    async *execute() {
      yield { type: 'result', value: currentPrincipal() };
    },
  },
};

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools:      [whoamiTool],
};
