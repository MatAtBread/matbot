export { ChatJimmyAdapter } from './adapter.js';

import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { ChatJimmyAdapter }      from './adapter.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  provider: (_config) => new ChatJimmyAdapter(),
};
