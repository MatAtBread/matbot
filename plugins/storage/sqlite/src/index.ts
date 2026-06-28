import { dirname, join } from 'node:path';
import type { MatbotPluginSpec, MatbotMachine } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { SQLiteStorageBackend } from './backend.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  storageBackend: {
    open: (dotData: string) => SQLiteStorageBackend.open(dotData),
  },
  async setup(services: MatbotMachine) {
    // Pre-scan already opened this backend at startup — nothing to do.
    if (services.StorageBackend instanceof SQLiteStorageBackend) return;
    // Hot-loaded at runtime: activate now.
    if (!services.configPath) return;
    const dotData = join(dirname(services.configPath), '.data');
    await services.register('StorageBackend', await SQLiteStorageBackend.open(dotData));
  },
};
