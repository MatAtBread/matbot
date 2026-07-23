import { dirname, join } from 'node:path';
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
let machine: MatbotMachine | undefined;
let watchRegistered = false;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  // Boot storage backend: the pre-scan opens it before the services object exists (list it before any
  // plugin whose setup() calls createStore). On a hot load there is no pre-scan; setup() installs it.
  storageBackend: {
    open: async (dotData: string) => { openedByPreScan = true; return ProfilesStorageBackend.open(dotData); },
  },

  async setup(services: MatbotMachine) {
    // Make the profiles backend the active one if it isn't already. The boot pre-scan (openedByPreScan)
    // installs it before any setup; a reload where a profile backend is still active is likewise a no-op.
    // Otherwise we were HOT-LOADED at runtime: open and register it now — mirroring the sqlite plugin. The
    // swap is deferred to the next quiescent edge (applied immediately when idle, at the turn's end when
    // loaded mid-turn), and unloadPlugin reverts it via the recorded service key. No restart needed. The
    // active-backend check is duck-typed, never `instanceof`: a hot reload gives this module a fresh class
    // identity, so an identity check would miss a still-active earlier instance.
    if (!openedByPreScan && asProfileDirectory(services.StorageBackend) === undefined) {
      if (!services.configPath) {
        console.warn('[storage-profiles] no configPath — cannot hot-activate the profiles backend; add it to matbot.yaml.');
        return;
      }
      const dotData = join(dirname(services.configPath), '.data');
      await services.register('StorageBackend', await ProfilesStorageBackend.open(dotData));
    }

    // The tools + WatchVisibility resolve their directory live (duck-typed, swap-safe) on each call, so
    // they follow any later StorageBackend swap and work the moment a deferred hot-load swap lands — even
    // if that is after this setup() returns — and never pin a stale or hot-reloaded instance.
    const dir = () => asProfileDirectory(services.StorageBackend);
    services.tools.register(createProfileTool(dir));
    services.tools.register(createShareTool(dir));
    toolRegistry = services.tools;
    machine = services;

    // Advertise the partition-aware file-watch layer so a frontend firehose observes every partition's
    // file events (origin-stamped) and filters each SSE connection by its principal. Delegates live to
    // the active backend (swap-safe), fail-open on visibility if the facet has gone.
    await services.register('WatchVisibility', {
      watchFiles: (signal) => dir()?.watchFiles(signal) ?? (async function* (): AsyncIterable<never> {})(),
      visible:    (viewer, ns, origin) => dir()?.visible(viewer, ns, origin) ?? true,
    });
    watchRegistered = true;
  },

  async teardown() {
    toolRegistry?.remove('profile_action');
    toolRegistry?.remove('share');
    toolRegistry = undefined;
    if (watchRegistered && machine) { machine.unregister('WatchVisibility'); watchRegistered = false; }
    machine = undefined;
  },
};
