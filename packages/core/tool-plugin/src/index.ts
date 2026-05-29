import type { Tool } from '@matatbread/matbot-plugin-api';
export { pluginTool } from './tools/plugin.js';

import { pluginTool } from './tools/plugin.js';

export function createBuiltinTools(): Tool[] {
  return [pluginTool];
}
