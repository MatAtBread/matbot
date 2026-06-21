import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }               from '@matatbread/matbot-plugin-api';
import { makeSessionTools }                 from './tools.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotMachine) {
    const store = services.sessions;
    if (!store) return;
    for (const tool of makeSessionTools(store)) {
      services.tools.register(tool);
    }
  },
};
