export { OpenAICompatAdapter } from './adapter.js';

import type { MatbotPlugin }     from '@matbot/plugin-api';
import { OpenAICompatAdapter }   from './adapter.js';

export const plugin: MatbotPlugin = {
  name:       '@matbot/provider-openai-compat',
  apiVersion: '0.1',
  providers: {
    'openai-compat': (_config) => new OpenAICompatAdapter(),
  },
};
