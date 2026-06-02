export { CustomerServicesAdapter } from './adapter.js';

import type { MatbotPlugin } from '@matatbread/matbot-plugin-api';
import { CustomerServicesAdapter } from './adapter.js';

export const plugin: MatbotPlugin = {
  name:       '@matatbread/matbot-provider-customer-services',
  apiVersion: '0.1',
  manifest: {
    description: 'Mock LLM provider for customer services scenarios. Always helpful, never useful.',
  },
  provider: (_config) => new CustomerServicesAdapter(),
};
