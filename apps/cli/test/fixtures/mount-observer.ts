import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

// Deliberately observes WITHOUT passing a signal — the shape a plugin author is free to write, and the
// one that used to leave a live mount interest behind after unload. The counter is module state so the
// test can see whether the handler still fires once the plugin is gone.
export const calls = { count: 0 };

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  setup(services) {
    services.mounted.observe({ key: 'StorageBackend' }, () => { calls.count++; });
  },
};
