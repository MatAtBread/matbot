export { WebLLMAdapter, DEFAULT_MODEL } from './adapter.js';
export { webllmModelsTool, type WebLLMModelList, type WebLLMModelSummary } from './models.js';

import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { WebLLMAdapter }         from './adapter.js';
import { webllmModelsTool }      from './models.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  provider: (_config) => new WebLLMAdapter(),
  tools: [webllmModelsTool],
};
