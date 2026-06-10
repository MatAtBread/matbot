import type { Tool } from '@matatbread/matbot-plugin-api';
export { pluginTool }         from './tools/plugin.js';
export { createProviderTool } from './tools/provider.js';
export { classifySpecifier, fetchRemoteManifest, materializeRemote } from './remote-cache.js';
export type { Classified, RemoteManifest } from './remote-cache.js';

import { pluginTool } from './tools/plugin.js';

export function createBuiltinTools(): Tool[] {
  return [pluginTool];
}
