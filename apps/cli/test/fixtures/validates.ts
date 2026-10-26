import type { MatbotPluginSpec, ToolInputError } from '@matatbread/matbot-plugin-api';

// A `validate` hook whose answer the test sets, by `?as=` name, on `globalThis.__validates`. Loaded more
// than once under different names, so each load is its own module and its own plugin.
const as = new URL(import.meta.url).searchParams.get('as') ?? 'a';
const answers = ((globalThis as Record<string, unknown>)['__validates'] ??= {}) as Record<string, () => ToolInputError[] | undefined>;

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  setup(services) {
    services.hooks.register({ on: 'validate', handler: () => answers[as]?.() });
  },
};
