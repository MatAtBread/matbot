import type { Tool } from '@matatbread/matbot-plugin-api';
export { pluginTool }         from './tools/plugin.js';
export { createProviderTool } from './tools/provider.js';

import { pluginTool } from './tools/plugin.js';

export function createBuiltinTools(): Tool[] {
  return [pluginTool];
}
