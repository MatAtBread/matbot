import type { MatbotPluginSpec, MatbotMachine, ToolRegistry } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { ProfilesStorageBackend, asProfileDirectory } from './backend.js';
import { createProfileTool, createShareTool } from './tool.js';

export { ProfilesStorageBackend, asProfileDirectory } from './backend.js';
export type { Profile, ProfileDirectory } from './backend.js';

// Per-module-instance flag, set when THIS module's storageBackend.open() runs — i.e. the boot pre-scan.
// A hot reload gives the plugin a fresh module (cache-busted URL) whose open() is NOT called (the
// pre-scan only runs at boot), so the flag stays false and setup() re-installs the backend.
let openedByPreScan = false;
let toolRegistry: ToolRegistry | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  // Boot storage backend: the pre-scan opens it before the services object exists (list it before any
  // plugin whose setup() calls createStore). On a hot load there is no pre-scan; setup() installs it.
  storageBackend: {
    open: async (dotData: string) => { openedByPreScan = true; return ProfilesStorageBackend.open(dotData); },
  },

  async setup(services: MatbotMachine) {
    // Register the `profile` tool only when profiles are genuinely the active backend — i.e. we were the
    // boot pre-scan (our open() ran), or the live StorageBackend already exposes the profile facet. The
    // check is duck-typed, never `instanceof`: a hot reload gives this module a fresh class identity, so
    // an identity check would miss a still-active earlier instance. A boot storage backend cannot be
    // reliably (re)installed at runtime — the host reverts it on unload and the swap is deferred to a
    // pump turn — so changing the storage backend is a restart-time operation; see README.
    if (!openedByPreScan && asProfileDirectory(services.StorageBackend) === undefined) {
      console.warn('[storage-profiles] not the active storage backend — `profile` tool not registered. A storage backend must be present at boot (restart after adding it); it cannot be hot-installed.');
      return;
    }

    // The tool resolves its directory live (duck-typed, swap-safe) on each call, so it follows any later
    // StorageBackend swap and never pins a stale or hot-reloaded instance.
    const dir = () => asProfileDirectory(services.StorageBackend);
    services.tools.register(createProfileTool(dir));
    services.tools.register(createShareTool(dir));
    toolRegistry = services.tools;
  },

  async teardown() {
    toolRegistry?.remove('profile');
    toolRegistry?.remove('share');
    toolRegistry = undefined;
  },
};
