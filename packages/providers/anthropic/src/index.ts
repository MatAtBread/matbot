export { AnthropicAdapter } from './adapter.js';

import type { MatbotPlugin } from '@matbot/plugin-api';
import { AnthropicAdapter }  from './adapter.js';

export const plugin: MatbotPlugin = {
  name:       '@matbot/provider-anthropic',
  apiVersion: '0.1',
  providers: {
    anthropic: (_config) => new AnthropicAdapter(),
  },
};
