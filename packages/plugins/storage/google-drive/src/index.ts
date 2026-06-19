import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { GoogleDriveStorageBackend, DRIVE_SCOPE } from './drive-backend.js';
import { DriveAuth } from './drive-auth.js';
import { runDriveSetup } from './drive-setup-overlay.js';
import { DriveVault } from './drive-vault.js';
import { DrivePluginSet, createSyncedPluginTool } from './drive-plugins.js';

// Config needed to *reach* Drive (client ID + root folder) lives in localStorage, not in matbot's
// swappable settings store — settings would be backed by Drive once this plugin activates, so
// bootstrapping from there would be circular. These two values are machine-local, non-secret config.
const CLIENT_ID_KEY = 'matbot.gdrive.clientId';
const ROOT_KEY      = 'matbot.gdrive.rootFolder';
// The localStorage key the browser plugin's LocalStorageVault persists under; read directly to
// migrate any secrets entered before Drive was activated (the Vault interface has no enumerate).
const LOCAL_VAULT_KEY = 'matbot.vault';

function readLocalVaultSecrets(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_VAULT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { return {}; }
}

function readLocal(key: string): string | undefined {
  try { return globalThis.localStorage?.getItem(key) ?? undefined; } catch { return undefined; }
}
function writeLocal(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value); } catch { /* unavailable */ }
}

/**
 * Authorise Drive and build the backend. Fast path: if a non-expired token is already cached for the
 * known client ID, reuse it silently (no popup, no dialog). Otherwise show the setup overlay, which
 * collects/confirms the client ID + folder and drives Google sign-in from a real button click (the
 * gesture Chrome requires to open the consent popup — a boot-time popup is blocked).
 */
async function authoriseAndBuild(): Promise<GoogleDriveStorageBackend> {
  const clientId   = readLocal(CLIENT_ID_KEY);
  const rootFolder = readLocal(ROOT_KEY);

  if (clientId) {
    const auth = new DriveAuth(clientId, DRIVE_SCOPE);
    if (auth.hasFreshToken()) return GoogleDriveStorageBackend.fromAuth(auth, rootFolder || 'matbot');
  }

  const result = await runDriveSetup({
    ...(clientId   ? { clientId }   : {}),
    ...(rootFolder ? { rootFolder } : {}),
  });
  writeLocal(CLIENT_ID_KEY, result.clientId);
  writeLocal(ROOT_KEY, result.rootFolder);
  return GoogleDriveStorageBackend.fromAuth(result.auth, result.rootFolder);
}

/**
 * Google Drive storage backend (browser). On activation it authorises the user's Google account
 * (reusing a cached token, or via the setup overlay) and registers a `StorageBackend` that persists
 * all documents and file blobs to a Drive folder — swapping out whatever backend (IndexedDB/OPFS by
 * default) was active. It then re-points the vault at Drive and restores the Drive-synced plugin set.
 *
 * It deliberately does NOT declare `storageBackend.open`: that boot pre-scan hook gets no config and
 * cannot show UI, so activation always runs through `setup()` (i.e. `plugin add`, which the browser
 * plugin then replays on every boot). On node there is no `document`, so it throws and the host keeps
 * its filesystem backend.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest:   { description: 'Persist matbot sessions, settings, files and secrets to a folder in your Google Drive (browser).' },

  async setup(services: MatbotServices): Promise<void> {
    if (services.StorageBackend instanceof GoogleDriveStorageBackend) return;
    const backend = await authoriseAndBuild();

    // Probe Drive with a real call BEFORE swapping it in. If Drive is misconfigured (most commonly
    // the Drive API isn't enabled for the project), fail here — nothing is registered, so the session
    // stays on its existing local backend rather than erroring on every store operation.
    try {
      await backend.ready();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        'Signed in to Google, but the Drive API call failed — your data has NOT been moved to Drive ' +
        '(still using local browser storage). The usual cause is that the Google Drive API is not ' +
        'enabled for this Cloud project yet. Enable it at ' +
        'https://console.cloud.google.com/apis/library/drive.googleapis.com (select the same project ' +
        'as your OAuth client), wait ~1 minute, then re-add this plugin.\n\nDrive said: ' + msg,
      );
    }

    await services.register('StorageBackend', backend);

    // Re-point the vault at Drive so secrets sync too. createStore('vault') now resolves to the
    // just-registered Drive backend; migrate any secrets the localStorage vault already holds so an
    // API key entered before activation isn't stranded, then swap the live vault.
    const vault = await DriveVault.open(backend.createStore('vault'));
    await vault.seedMissing(readLocalVaultSecrets());
    await services.register('Vault', vault);

    // Shadow the `plugin` tool with one backed by the Drive-synced set, so there is a single `plugin`
    // tool (the model and the /tools path can't pick a wrong one) and installs sync across machines.
    // Capture the existing (local) tool first so self-removal can pass through to it. Then restore
    // the Drive-synced set — the local loader, which already loaded *this* plugin, is untouched.
    // Failures are warned, never fatal — a stale specifier must not abort boot.
    const pluginSet = new DrivePluginSet(backend.createStore('plugin-manifest'));
    const originalPluginTool = services.tools.resolve('plugin');
    services.tools.register(createSyncedPluginTool(pluginSet, originalPluginTool));
    for (const specifier of await pluginSet.list()) {
      try {
        await services.loadPlugin(specifier);
      } catch (e) {
        console.warn(`[matbot-gdrive] Could not restore Drive-synced plugin "${specifier}":`, e);
      }
    }
  },

  // Shown after a successful activation — confirms what happened and records the one-time Google
  // setup steps in the chat, so they're to hand when reconnecting on a new browser or Google project.
  async installationMessage(): Promise<string> {
    const folder = readLocal(ROOT_KEY) ?? 'matbot';
    return [
      `✅ **Google Drive storage connected.** Your sessions, settings, files and secrets now live in your Google Drive under \`${folder}/\`, so they follow you between browsers.`,
      '',
      'Reconnecting on another browser (or setting up a fresh Google project) is a one-time, ~2-minute job:',
      '',
      '1. **Create an OAuth client ID** — [Google Cloud → Create OAuth client ID](https://console.cloud.google.com/auth/clients/create), type **Web application**, and add this page\'s origin under *Authorised JavaScript origins*.',
      '2. **Enable the Google Drive API** for that project — [API library → Enable](https://console.cloud.google.com/apis/library/drive.googleapis.com). Without this, sign-in works but every Drive call returns `403: API not enabled` (allow ~1 min to propagate).',
      '3. **Add yourself as a test user** — OAuth consent screen → *Audience* → *Test users* → *Add users*. (Skip this and you get a hard `403: access_denied`.)',
      '4. **Connect** — paste the Client ID into the Connect dialog. On the *"this app isn\'t verified"* screen, click *Advanced → Go to … (unsafe) → Continue* — it\'s your own app touching only the files it creates (`drive.file`), so it\'s safe; personal use needs no Google verification.',
      '',
      'From now on, `plugin add <name>` saves to your Drive too, so plugins you install appear on every browser where Drive is connected (removing *this* plugin stays local, since it\'s what connects to Drive).',
    ].join('\n');
  },
};

export { GoogleDriveStorageBackend, DRIVE_SCOPE } from './drive-backend.js';
export { DriveAuth, preloadGsi } from './drive-auth.js';
export { DriveClient }    from './drive-client.js';
export { DriveStore }     from './drive-store.js';
export { DriveFileStore } from './drive-file-store.js';
export { DriveVault }     from './drive-vault.js';
export { DrivePluginSet, createSyncedPluginTool } from './drive-plugins.js';
export { runDriveSetup }  from './drive-setup-overlay.js';
