export { OpenAICompatAdapter } from './adapter.js';
export { foreignToolNote, signedBy } from './convert.js';

import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec }     from '@matatbread/matbot-plugin-api';
import { OpenAICompatAdapter }   from './adapter.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  provider: (_config) => new OpenAICompatAdapter(),
};
