export { WebLLMAdapter, DEFAULT_MODEL } from './adapter.js';
export { webllmModelsTool, type WebLLMModelList, type WebLLMModelSummary } from './models.js';

import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { WebLLMAdapter }         from './adapter.js';
import { webllmModelsTool }      from './models.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  provider: (_config) => new WebLLMAdapter(),
  tools: [webllmModelsTool],
};
