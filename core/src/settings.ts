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
 * Build a PluginSettings facade over the shared settings store, scoped to one document id.
 *
 * Every read used to also decide whether the document was in the pre-Store flat `{ key: value }` format
 * and, if so, wrap it under a `version: '0'` sentinel that `set`/`delete` then had to recognise and
 * upgrade with `set` instead of `cas` — a three-site migration paid for on every `settings.get()` by
 * every plugin, forever. Dropped at 0.4.0: an unrecognised document is treated as absent, so a flat one
 * would be re-created on first write rather than read. Nothing in the wild is still flat.
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
      return (await getDoc())?.data[key] as T | undefined;
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
