import type { PluginSettings, Store } from '@matatbread/matbot-plugin-api';

export interface SettingsDoc {
  id:      string;
  version: string;
  data:    Record<string, unknown>;
}

export function isSettingsDoc(v: unknown): v is SettingsDoc {
  return typeof v === 'object' && v !== null &&
    typeof (v as SettingsDoc).id      === 'string' &&
    typeof (v as SettingsDoc).version === 'string' &&
    typeof (v as SettingsDoc).data    === 'object' && (v as SettingsDoc).data !== null;
}

/**
 * Settings namespaces double as Store document ids, which the filesystem store restricts to
 * /^[\w-]+$/. Plugin names are now loader-derived package names (`@scope/pkg`), so slug them to a
 * safe id. Collisions are theoretically possible but irrelevant for this install scale.
 */
export function slugSettingsNamespace(name: string): string {
  return name.replace(/[^\w-]+/g, '_');
}

/**
 * The install's config-supplied floor for plugin settings, keyed by plugin name (the settings
 * namespace). Installed once by the host at boot from `default_settings:` in matbot.yaml (node) or
 * `BrowserConfig.defaultSettings` (browser); empty otherwise.
 *
 * Module state consulted INSIDE {@link makePluginSettings}, rather than a parameter it takes, because
 * a parameter is a thing a call site forgets with no error and no symptom — and there is already a
 * call site that would: `plugins/browser` builds its own facade over a concrete backend on purpose,
 * to pin its plugin list to local storage across a StorageBackend swap. A default it silently didn't
 * see would be indistinguishable from one the user never wrote.
 */
let installDefaults: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map();

/** Host boot assembly: install the read-only defaults. Call before any plugin loads. */
export function installSettingsDefaults(byPlugin: ReadonlyMap<string, Readonly<Record<string, unknown>>> | undefined): void {
  installDefaults = byPlugin ?? new Map();
}

/** The plugin names the install supplies defaults for — the host checks these against what loaded. */
export function settingsDefaultNamespaces(): readonly string[] {
  return [...installDefaults.keys()];
}

/**
 * Build a PluginSettings facade over the shared settings store, scoped to one document id.
 *
 * Every read used to also decide whether the document was in the pre-Store flat `{ key: value }` format
 * and, if so, wrap it under a `version: '0'` sentinel that `set`/`delete` then had to recognise and
 * upgrade with `set` instead of `cas` — a three-site migration paid for on every `settings.get()` by
 * every plugin, forever. Dropped at 0.4.0: an unrecognised document is treated as absent, so a flat one
 * would be re-created on first write rather than read. Nothing in the wild is still flat.
 *
 * Reads are layered over {@link installDefaults}: a stored key wins, else the install's default, else
 * undefined (and then whatever the plugin's own code defaults to — so config beats code). Writes are
 * NOT layered: `update` reads the stored document only, so setting one key never persists another
 * key's default. Seeding on write would make a later config edit work or not work depending on
 * unrelated write history, which is unexplainable to whoever edits the yaml.
 */
export function makePluginSettings(store: Store<SettingsDoc>, namespace: string): PluginSettings {
  const id = slugSettingsNamespace(namespace);

  const getDoc = async (): Promise<SettingsDoc | null> => {
    const raw = await store.get(id);
    return raw !== null && isSettingsDoc(raw) ? raw : null;
  };

  // One CAS retry loop for both writers: read, apply `mutate`, write. A document that vanished between
  // read and write (or never existed) is a plain `set`; otherwise `cas` guards the version we read.
  const update = async (mutate: (data: Record<string, unknown>) => Record<string, unknown> | undefined): Promise<void> => {
    for (;;) {
      const doc  = await getDoc();
      const data = mutate(doc?.data ?? {});
      if (data === undefined) return;
      const next: SettingsDoc = { id, version: Date.now().toString(), data };
      if (doc === null) { await store.set(id, next); return; }
      const r = await store.cas(id, doc.version, next);
      if (r.ok) return;
    }
  };

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const doc = await getDoc();
      // `in`, not a truthiness or undefined test: a stored null is an override the plugin gets to
      // interpret, and `delete` — not writing null — is how a caller reverts to the install default.
      if (doc !== null && key in doc.data) return doc.data[key] as T | undefined;
      return installDefaults.get(namespace)?.[key] as T | undefined;
    },
    set<T>(key: string, value: T): Promise<void> {
      return update(data => ({ ...data, [key]: value as unknown }));
    },
    delete(key: string): Promise<void> {
      return update(data => {
        if (!(key in data)) return undefined;
        const next = { ...data };
        delete next[key];
        return next;
      });
    },
  };
}
