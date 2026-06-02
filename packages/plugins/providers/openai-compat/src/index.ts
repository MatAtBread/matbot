export { OpenAICompatAdapter } from './adapter.js';

import type { MatbotPlugin }     from '@matatbread/matbot-plugin-api';
import { OpenAICompatAdapter }   from './adapter.js';

export const plugin: MatbotPlugin = {
  name:       '@matatbread/matbot-provider-openai-compat',
  apiVersion: '0.1',
  provider: (_config) => new OpenAICompatAdapter(),
};
