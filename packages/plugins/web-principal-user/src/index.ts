import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
// Type-only: brings the `WebPrincipalResolver` augmentation of MatbotServices into scope so the
// register call below is typed. Erased at runtime — this plugin does NOT load the web frontend; it
// only offers a resolver the frontend reads per-request if it happens to be present.
import type { WebPrincipalResolver } from '@matatbread/matbot-frontend-web';
import process from 'node:process';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services: MatbotServices) {
    const resolver: WebPrincipalResolver = () => ({
      id:   process.env['USER'] ?? 'unknown',
      type: 'user',
    });
    await services.register('WebPrincipalResolver', resolver);
  },
};
