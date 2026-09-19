import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { log } from './teardown-log.ts';

// A teardown that never settles: the budget, not this plugin, decides when the next one runs.
export const plugin: MatbotPluginSpec = { apiVersion: '0.1', teardown: () => { log.push('hangs'); return new Promise<void>(() => {}); } };
