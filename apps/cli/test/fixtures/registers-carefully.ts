import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

// Registers one service twice, and attempts one the host refuses.
export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  async setup(services) {
    await services.register('ToolTypeIndex', {} as never);
    await services.register('ToolTypeIndex', {} as never);
    await services.register('KnowledgeIndex', {} as never).catch(() => {});
  },
};
