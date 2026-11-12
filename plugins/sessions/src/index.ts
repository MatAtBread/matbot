import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }               from '@matatbread/matbot-plugin-api';
import { makeSessionTools }                 from './tools.js';

export { makeSessionTools, type SessionSummary } from './tools.js';
export { isUnread, sessionIndicator, type SessionIndicator } from './read-state.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotMachine) {
    const store = services.sessions;
    if (!store) return;
    const tools = makeSessionTools(store, {
      run:        () => services.run,
      appender:   () => services.SessionAppender,
      isSubAgent: () => services.isSubAgent(),
    });
    for (const tool of tools) {
      services.tools.register(tool);
    }
  },
};
