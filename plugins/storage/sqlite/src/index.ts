import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { SQLiteStorageBackend } from './backend.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  storageBackend: {
    open: (dataDir: string) => SQLiteStorageBackend.open(dataDir),
  },
  async setup(services: MatbotMachine) {
    // Pre-scan already opened this backend at startup — nothing to do.
    if (services.StorageBackend instanceof SQLiteStorageBackend) return;
    // Hot-loaded at runtime: activate now.
    if (services.dataDir === undefined) return;
    await services.register('StorageBackend', await SQLiteStorageBackend.open(services.dataDir));
  },
};
