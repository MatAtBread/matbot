import type { MatbotPluginSpec, MatbotServices, PluginSettings } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makePluginSettings, type SettingsDoc } from '@matatbread/matbot-core';
import { BrowserStorageBackend, assertBrowserRealm } from './storage-backend.js';
import { createBrowserPluginTool, type ExtraPlugins } from './plugin-tool.js';

const EXTRA_KEY = 'extra-plugins';

/**
 * The browser defaults plugin. Supplies the platform storage backend (IndexedDB + OPFS) and the
 * browser `plugin` management tool — the browser analogue of the node app's filesystem stores and
 * built-in `plugin` tool, but shipped as a plugin (not core), so the web build is assembled purely
 * from plugins over a platform-neutral core.
 *
 * Because the browser has no matbot.yaml, this plugin also owns the durable list of *user-added*
 * plugins: `add`/`remove` persist into its own settings (IndexedDB), and `setup()` replays them on
 * boot via `services.loadPlugin`, so a session's installed plugins survive a realm reload.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest:   { description: 'Browser defaults: IndexedDB + OPFS storage backend and the browser plugin manager.' },

  storageBackend: {
    open: (dotData: string) => BrowserStorageBackend.open(dotData),
  },

  async setup(services: MatbotServices): Promise<void> {
    // Browser-only: on node this throws, the loader logs and skips the plugin, and the host keeps its
    // real (filesystem) backend — no dead config.
    assertBrowserRealm();

    // Hot-load path: if we weren't activated by the boot pre-scan, become the backend now so all
    // stores (including the settings store this plugin uses below) land in IndexedDB.
    if (!(services.StorageBackend instanceof BrowserStorageBackend)) {
      await services.register('StorageBackend', await BrowserStorageBackend.open(''));
    }

    // Bind the extras list to the backend that is active *now* (the local IndexedDB default), captured
    // concretely so it survives a later StorageBackend swap. `services.settings()` goes through the
    // swappable store proxy, so if a plugin swaps the backend during its own load (e.g. the Google
    // Drive backend, mid-`add`), the post-load write would land in the *new* backend while boot reads
    // the default and never finds it — that plugin would silently fail to persist itself into the
    // auto-load list, and `remove` would write to the wrong store too. Capturing the concrete store
    // (BrowserStorageBackend caches per namespace, so this is the very same IndexedDB store/doc the
    // proxy used — no migration, no data move) pins the list to local storage regardless of swaps.
    // The namespace is this plugin's name, matching what `services.settings()` used before.
    const backend = services.StorageBackend;
    const settings: PluginSettings = backend !== undefined
      ? makePluginSettings(backend.createStore<SettingsDoc>('settings'), services.self?.name ?? 'matbot-browser')
      : services.settings();
    const extras: ExtraPlugins = {
      async list() {
        return (await settings.get<string[]>(EXTRA_KEY)) ?? [];
      },
      async add(specifier: string) {
        const cur = (await settings.get<string[]>(EXTRA_KEY)) ?? [];
        if (!cur.includes(specifier)) await settings.set(EXTRA_KEY, [...cur, specifier]);
      },
      async remove(specifier: string) {
        const cur = (await settings.get<string[]>(EXTRA_KEY)) ?? [];
        await settings.set(EXTRA_KEY, cur.filter(s => s !== specifier));
      },
    };

    services.tools.register(createBrowserPluginTool(extras));

    // Replay user-added plugins from a previous realm. Failures are warned and skipped — a stale
    // specifier (a URL that 404s now) must not abort boot.
    for (const specifier of await extras.list()) {
      try {
        await services.loadPlugin(specifier);
      } catch (e) {
        console.warn(`[matbot-browser] Could not replay persisted plugin "${specifier}":`, e);
      }
    }
  },
};
