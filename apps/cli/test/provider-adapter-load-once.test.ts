import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instantiateProvider } from '@matatbread/matbot-core';
import type { MatbotRuntime, ProviderConfig, ProviderAdapter } from '@matatbread/matbot-core';

// A provider whose module `plugins:` does not list is loaded on first use. Boot is when first uses
// arrive together — a skills reindex analyses every skill at once, through one provider — and each
// started its own load: the first won, the rest died on "already registered", and their `complete()`
// calls failed. Seen on every boot of a config with skills and an unlisted adapter module.
test('concurrent first uses of an unloaded adapter share one load', async () => {
  let loads = 0;
  let loaded = false;
  const adapter = {} as ProviderAdapter;
  const services = {
    resolver: undefined,
    async loadPlugin(spec: string) {
      loads++;
      if (loaded) throw new Error(`Plugin "${spec}" is already registered.`);
      await new Promise(r => setTimeout(r, 10));
      loaded = true;
      return { name: spec, provider: () => adapter };
    },
  } as unknown as MatbotRuntime;
  const config = { name: 'p', module: `adapter-${Date.now()}`, model: 'm' } as ProviderConfig;

  const results = await Promise.all(Array.from({ length: 5 }, () => instantiateProvider(services, config)));

  assert.equal(loads, 1, 'the module is loaded once');
  assert.ok(results.every(r => r === adapter), 'and every caller gets the adapter');
});

test('a failed load is not remembered: the next use tries again', async () => {
  let loads = 0;
  const adapter = {} as ProviderAdapter;
  const services = {
    resolver: undefined,
    async loadPlugin() {
      if (++loads === 1) throw new Error('transient');
      return { name: 'x', provider: () => adapter };
    },
  } as unknown as MatbotRuntime;
  const config = { name: 'p', module: `adapter-retry-${Date.now()}`, model: 'm' } as ProviderConfig;

  assert.equal(await instantiateProvider(services, config), null);
  assert.equal(await instantiateProvider(services, config), adapter);
});
