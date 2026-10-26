import type { MatbotPluginSpec } from '@matatbread/matbot-plugin-api';

// Registers over whatever holds a key, capturing what it displaces — the capture-and-delegate idiom a
// gate uses to compose with the one it replaces. Loaded more than once under different `?as=` names, so each load is
// its own module and its own plugin.
const as = new URL(import.meta.url).searchParams.get('as') ?? 'a';
const key = new URL(import.meta.url).searchParams.get('key') ?? 'ExampleService';

export interface Layer { as: string; previous: Layer | undefined }

export const plugin: MatbotPluginSpec = {
  apiVersion: '0.1',
  async setup(services) {
    const previous = (services as unknown as Record<string, Layer | undefined>)[key];
    await services.register(key as never, { as, previous } as never);
  },
};
