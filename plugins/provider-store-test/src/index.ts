import type { MatbotPluginSpec, MatbotMachine, ProviderConfig, Store } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

/**
 * ⚠️  DEMONSTRATION / REFERENCE PLUGIN — NOT A USEFUL FEATURE IN ITSELF.  ⚠️
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * In a node environment this plugin does nothing you'd actually want: it just clones an already-
 * configured provider under a `<name>-viastore` alias. Its whole reason to exist is to be a **runnable
 * (CLI) proof** of the provider-contribution machinery — a plugin registering LLM provider profiles into
 * `services.providers` at setup, having them resolve for real turns, and reverting them on unload — which
 * the real consumer (`@matatbread/matbot-storage-google-drive`) can only exercise in a browser.
 *
 * Read it as a **template**. Swap the "clone a configured provider" seed for "read profiles from a shared
 * resource" and you have the shape of a genuinely useful plugin: provider config centralised in a database,
 * an internal config service, a git-synced file, an S3 object, etc. The load-bearing pattern is the same
 * three moves, independent of where the profiles come from:
 *   1. setup(): fetch profiles from your medium → `services.providers.register(profile)` for each.
 *   2. runtime: the adapter module named by each profile self-heals (loads on first use) — no pre-wiring.
 *   3. teardown(): `services.providers.revert(name)` for each, so unload restores the host's boot set.
 * A production version would additionally shadow the `provider` tool (see the browser
 * `createBrowserProviderTool` + a `ProviderAdmin` over your medium, as google-drive does) so `add`/`remove`
 * write back to the shared resource. This demo deliberately omits that to stay minimal.
 *
 * It never overrides a configured provider — only adds a `<name>-viastore` clone. Add it to a `matbot.yaml`
 * plugins list to try it.
 */

const DOC_ID = 'manifest';
const SUFFIX = '-viastore';

interface ManifestDoc {
  id:        string;
  version:   string;
  providers: ProviderConfig[];
}

// teardown() receives no services, so capture what setup registered in order to undo it on unload.
let contributed: { services: MatbotMachine; names: string[] } | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: { description: 'TEST/reference: contribute provider profiles from a plugin-owned store (node stand-in for a storage backend syncing providers).' },

  async setup(services: MatbotMachine): Promise<void> {
    const store: Store<ManifestDoc> = services.createStore<ManifestDoc>('provider-store-test');
    let doc = await store.get(DOC_ID);
    if (!doc) {
      // Seed once by cloning a configured provider (prefer the cheapest) under a distinct name, so this
      // plugin contributes a genuinely working profile without hardcoding an endpoint or secret.
      const src = services.providers.get('haiku-4.5-azure') ?? [...services.providers.values()][0];
      if (src === undefined) {
        console.warn('[provider-store-test] no configured provider to clone; nothing to contribute.');
        return;
      }
      doc = { id: DOC_ID, version: crypto.randomUUID(), providers: [{ ...src, name: `${src.name}${SUFFIX}` }] };
      await store.set(DOC_ID, doc);
    }
    for (const p of doc.providers) {
      services.providers.register(p);
      console.warn(`[provider-store-test] contributed provider "${p.name}" (module "${p.module}").`);
    }
    contributed = { services, names: doc.providers.map(p => p.name) };
  },

  async teardown(): Promise<void> {
    if (contributed === undefined) return;
    for (const name of contributed.names) {
      contributed.services.providers.revert(name);
      console.warn(`[provider-store-test] reverted provider "${name}".`);
    }
    contributed = undefined;
  },
};
