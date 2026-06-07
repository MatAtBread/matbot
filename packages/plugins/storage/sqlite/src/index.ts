import { dirname, join } from 'node:path';
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { SQLiteStorageBackend } from './backend.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  storageBackend: {
    open: (dotData: string) => SQLiteStorageBackend.open(dotData),
  },
  async setup(services: MatbotServices) {
    // Pre-scan already opened this backend at startup — nothing to do.
    if (services.storageBackend instanceof SQLiteStorageBackend) return;
    // Hot-loaded at runtime: activate now.
    if (!services.configPath) return;
    const dotData = join(dirname(services.configPath), '.data');
    await services.register('storageBackend', await SQLiteStorageBackend.open(dotData));
  },
};
