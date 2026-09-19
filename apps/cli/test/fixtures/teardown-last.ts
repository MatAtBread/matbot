import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { log } from './teardown-log.ts';

export const plugin: MatbotPluginSpec = { apiVersion: '0.1', teardown() { log.push('last'); } };
