// Imports cleanly and is plugin-shaped, but throws during setup() — the third way a plugin fails to
// load (past the import + shape gates, into the setup/rollback path). The loader must roll back and,
// in skip mode, record the failure rather than swallow it.
import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  setup() {
    throw new Error('boom in setup');
  },
};
