import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { ChatUI } from './ui.js';

/**
 * In-process browser frontend. Mounts a chat UI into the DOM and drives `services.run` directly —
 * the same contract a remote frontend uses over HTTP/SSE, minus the wire. The mount point is
 * `#matbot-root` if present, else `document.body`.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest:   { description: 'Browser chat frontend rendering to the DOM (in-process, no server).' },

  async setup(services: MatbotServices): Promise<void> {
    services.registerFrontend({ name: 'frontend-dom' });
    const root = document.getElementById('matbot-root') ?? document.body;
    await new ChatUI(services, root).mount();
  },
};
