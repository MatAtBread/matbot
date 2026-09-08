import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

// Registers a service and closes it in teardown, which is what `tool-types` does with its
// `ToolTypeIndex` (the index owns a worker thread, so closing it is not optional). The question this
// fixture exists to answer is whether the plugin must ALSO unregister the key itself: if the loader
// leaves it registered, a consumer keeps resolving a CLOSED service and every call through it fails.
export const state = { closed: false };

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  async setup(services) {
    state.closed = false;
    await services.register('ToolTypeIndex', { closed: () => state.closed } as never);
  },
  teardown() { state.closed = true; },
};
