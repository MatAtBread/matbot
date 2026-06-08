import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
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

    const settings = services.settings();
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
