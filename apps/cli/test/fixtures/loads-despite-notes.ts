// A second well-formed plugin, distinct from valid-plugin only in name: two loads of one specifier
// collide on the registry's name check, and this file's test needs a load that succeeds without
// consuming the one valid-plugin exists for.
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
};
