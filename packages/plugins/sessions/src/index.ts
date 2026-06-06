import type { MatbotPlugin, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION }               from '@matatbread/matbot-plugin-api';
import { makeSessionTools }                 from './tools.js';

export const plugin: MatbotPlugin = {
  name:       '@matatbread/matbot-sessions',
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotServices) {
    const store = services.sessions;
    if (!store) return;
    for (const tool of makeSessionTools(store, () => services.run)) {
      services.tools.register(tool);
    }
  },
};
