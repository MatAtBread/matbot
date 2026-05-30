import type { MatbotPlugin } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { SQLiteStorageBackend } from './backend.js';

export const plugin: MatbotPlugin = {
  name:       '@matatbread/matbot-storage-sqlite',
  apiVersion: PLUGIN_API_VERSION,
  storageBackend: {
    open: (dotData: string) => SQLiteStorageBackend.open(dotData),
  },
};
