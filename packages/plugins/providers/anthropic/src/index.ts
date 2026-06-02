export { AnthropicAdapter } from './adapter.js';

import type { MatbotPlugin } from '@matatbread/matbot-plugin-api';
import { AnthropicAdapter }  from './adapter.js';

export const plugin: MatbotPlugin = {
  name:       '@matatbread/matbot-provider-anthropic',
  apiVersion: '0.1',
  provider: (_config) => new AnthropicAdapter(),
};
