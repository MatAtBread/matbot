import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { FilesystemStorageBackend } from './backend.js';

// FilesystemStorageBackend is exported for the host to construct its own boot base directly (apps/cli
// wires it as the zero-plugin default). The `plugin` export is the same backend, installable — made
// nameable so it can be asserted to override another backend rather than only reverted to by
// unregistering whatever is in force.
export { FilesystemStore } from './store.js';
export { FilesystemStorageBackend } from './backend.js';
export { FilesystemFileStore } from './file-store.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  storageBackend: {
    open: (dataDir: string) => FilesystemStorageBackend.open(dataDir),
  },
  async setup(services: MatbotMachine) {
    // Pre-scan already opened this backend at startup — nothing to do.
    if (services.StorageBackend instanceof FilesystemStorageBackend) return;
    // Hot-loaded at runtime: activate now.
    if (services.dataDir === undefined) return;
    await services.register('StorageBackend', await FilesystemStorageBackend.open(services.dataDir));
  },
};
