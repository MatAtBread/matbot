import type { StorageBackend } from '@matatbread/matbot-plugin-api';
import { makePluginSettings, type SettingsDoc } from '@matatbread/matbot-core';
import type { ExtraPlugins } from '@matatbread/matbot-browser';

// Where the user's own `plugin add`s are kept: the browser analogue of matbot.yaml's `plugins:`. The
// namespace is the browser plugin's package name, which held the list when the plugin kept it;
// browsers that installed plugins then are read from where they wrote.
const NAMESPACE = '@matatbread/matbot-browser';
const KEY       = 'extra-plugins';

/**
 * The persisted list of user-added plugins, over a concrete backend rather than the swappable store
 * proxy. A plugin may swap the StorageBackend during its own load (Google Drive, mid-`add`); through
 * the proxy, the post-load write would land in the new backend while the next boot reads the old one,
 * so the plugin would silently fail to persist itself, and `remove` would write to the wrong store too.
 * Pinned to the host's own backend, the list is where the next boot looks, whatever is swapped in.
 */
export function localExtraPlugins(backend: StorageBackend): ExtraPlugins {
  const settings = makePluginSettings(backend.createStore<SettingsDoc>('settings'), NAMESPACE);
  return {
    async list() {
      return (await settings.get<string[]>(KEY)) ?? [];
    },
    async add(specifier: string) {
      const cur = (await settings.get<string[]>(KEY)) ?? [];
      if (!cur.includes(specifier)) await settings.set(KEY, [...cur, specifier]);
    },
    async remove(specifier: string) {
      const cur = (await settings.get<string[]>(KEY)) ?? [];
      await settings.set(KEY, cur.filter(s => s !== specifier));
    },
  };
}
