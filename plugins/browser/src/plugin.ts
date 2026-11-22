import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { BrowserStorageBackend, assertBrowserRealm } from './storage-backend.js';

/**
 * The browser's IndexedDB + OPFS backend, installable. The web bundle already boots on it (it builds a
 * `BrowserStorageBackend` itself, with the `plugin` tool and the list of plugins a user added), so this
 * plugin's point is that the backend becomes nameable — something to assert over another backend,
 * rather than only reached by unloading whatever is in force. The browser analogue of `storage-filesystem`.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest:   { description: 'The browser IndexedDB + OPFS storage backend, as a plugin that can be asserted over another.' },

  storageBackend: {
    open: (dataDir: string) => BrowserStorageBackend.open(dataDir),
  },

  async setup(services: MatbotMachine): Promise<void> {
    // Browser-only: on node this throws, the loader logs and skips the plugin, and the host keeps its
    // own backend — no dead config.
    assertBrowserRealm();
    // Pre-scan already opened this backend at startup — nothing to do. Hot-loaded: activate now.
    if (services.StorageBackend instanceof BrowserStorageBackend) return;
    await services.register('StorageBackend', await BrowserStorageBackend.open(''));
  },
};
