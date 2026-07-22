import { join } from 'node:path';
import type { Store, FileStore, StorageBackend } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-core';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';

/**
 * A stored partition of storage keyed by principal id. `id` doubles as the principal id and the
 * on-disk partition directory name, so it is constrained to a filesystem-safe token. `isolated` is the
 * set of namespaces this profile keeps in its own partition (everything else falls through to base);
 * `sharedFrom` maps a namespace to another profile's id (or '' for base) so two profiles can share one
 * namespace's data — the hook for symlink-free sharing.
 */
export interface Profile {
  id:          string;
  version:     string;
  name:        string;
  isolated:    string[];
  sharedFrom?: Record<string, string>;
  createdAt:   string;
  updatedAt:   string;
}

/**
 * The profile-registry facet the `profile` tool drives. Consumers reach it via {@link asProfileDirectory}
 * — a duck-typed check, never `instanceof`: a hot reload gives the module a fresh `ProfilesStorageBackend`
 * class, so an identity check would miss a still-active earlier instance. Method presence is identity-
 * independent and works through the capture-safe StorageBackend proxy.
 */
export interface ProfileDirectory {
  listProfiles(): Profile[];
  createProfile(name: string, isolated?: string[]): Promise<Profile>;
  deleteProfile(id: string): Promise<boolean>;
  setIsolated(id: string, isolated: string[]): Promise<Profile>;
  // The namespaces observed so far (a lower bound — a namespace appears only once its owning plugin has
  // called createStore this session), minus those that can never be isolated. Drives the UI's picker.
  availableNamespaces(): string[];
}

/** Narrow any active StorageBackend to its {@link ProfileDirectory} facet by method presence, or undefined. */
export function asProfileDirectory(backend: unknown): ProfileDirectory | undefined {
  const b = backend as Partial<ProfileDirectory> | null | undefined;
  return b
    && typeof b.listProfiles        === 'function'
    && typeof b.createProfile       === 'function'
    && typeof b.deleteProfile       === 'function'
    && typeof b.setIsolated         === 'function'
    && typeof b.availableNamespaces === 'function'
    ? (b as ProfileDirectory)
    : undefined;
}

// The namespace holding the profile registry itself. Lives at the base layout (never routed), so the
// directory of profiles is identical from every principal, including the default.
const PROFILE_REGISTRY_NS = 'profile-registry';

// Namespaces that are always served from the base partition, whatever the current principal:
//   - `settings` is a single shared bucket keyed by plugin name *above* the store, so it can't be
//     split per profile without moving every plugin's settings (see brief point 3);
//   - the profile registry must be global or profiles would be invisible from other principals.
const ALWAYS_BASE = new Set<string>(['settings', PROFILE_REGISTRY_NS]);

// The base partition, denoted by the empty partition id throughout.
const BASE = '';

// Namespaces a freshly-created profile isolates by default when the caller doesn't specify. Sessions only.
const DEFAULT_ISOLATED = ['sessions'];

/**
 * A StorageBackend that partitions selected namespaces per web principal. It does not wrap the active
 * backend service — it composes the filesystem *primitive* directly (one {@link FilesystemStorageBackend}
 * rooted at the base layout, plus one per profile rooted under `profiles/<id>/`), and routes each store
 * operation on the ambient `currentPrincipal()`:
 *
 *   - the default/unknown principal, `settings`, and any namespace not in the profile's `private` set
 *     resolve to the base layout — byte-identical to the plain filesystem backend, so existing data is
 *     untouched and visible;
 *   - a named profile whose `private` set includes the namespace resolves to that profile's partition.
 *
 * Routing reads only the in-memory profile map (loaded at open, updated on create/delete), never a
 * store — so there is no re-entrancy through the routing layer while resolving a route.
 */
export class ProfilesStorageBackend implements StorageBackend, ProfileDirectory {
  readonly fileStore: FileStore;

  private readonly dotData:    string;
  private readonly base:       StorageBackend;
  private readonly registry:   Store<Profile>;
  private readonly profiles                    = new Map<string, Profile>();
  private readonly partitions                  = new Map<string, StorageBackend>();
  // Cached per (partition, namespace) so a namespace's FilesystemStore — and its per-key CAS lock map —
  // is reused across operations rather than rebuilt each call (a fresh store per op would lose the lock).
  private readonly subStores                   = new Map<string, Store<{ id: string; version: string }>>();
  // Every namespace seen through createStore this session, plus each profile's isolated set seeded at open.
  // A lower bound (lazily-created namespaces appear only once touched) — good for UI suggestions, not for
  // hard validation. ALWAYS_BASE members are filtered out at read time in availableNamespaces().
  private readonly observed                    = new Set<string>();

  private constructor(dotData: string, base: StorageBackend) {
    this.dotData   = dotData;
    this.base      = base;
    this.fileStore = base.fileStore;                         // files are unprofiled for now (a separate axis)
    this.registry  = base.createStore<Profile>(PROFILE_REGISTRY_NS);
  }

  static async open(dotData: string): Promise<ProfilesStorageBackend> {
    const base    = await FilesystemStorageBackend.open(dotData);
    const backend = new ProfilesStorageBackend(dotData, base);
    const { items } = await backend.registry.query({});
    for (const p of items) {
      backend.profiles.set(p.id, p);
      for (const ns of p.isolated) backend.observed.add(ns);
    }
    for (const ns of DEFAULT_ISOLATED) backend.observed.add(ns);
    return backend;
  }

  // ── StorageBackend ─────────────────────────────────────────────────────────────

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    this.observed.add(namespace);
    const pick = (): Store<T> => this.subStore<T>(this.route(namespace), namespace);
    return {
      get:    (id)                  => pick().get(id),
      set:    (id, value)           => pick().set(id, value),
      cas:    (id, expected, next)  => pick().cas(id, expected, next),
      delete: (id, expectedVersion) => pick().delete(id, expectedVersion),
      query:  (q)                   => pick().query(q),
    };
  }

  async close(): Promise<void> {
    await this.base.close?.();
    for (const p of this.partitions.values()) await p.close?.();
  }

  // ── Profile registry (consumed by the `profile` tool) ────────────────────────────

  listProfiles(): Profile[] {
    return [...this.profiles.values()];
  }

  async createProfile(name: string, isolated?: string[]): Promise<Profile> {
    const id = name.trim();
    if (!/^[\w-]+$/.test(id)) {
      throw new Error(`Invalid profile name "${name}": use only letters, digits, underscore or hyphen.`);
    }
    if (this.profiles.has(id)) throw new Error(`Profile "${id}" already exists.`);
    const now: string = new Date().toISOString();
    const profile: Profile = {
      id, version: crypto.randomUUID(), name: id,
      isolated: this.cleanIsolated(isolated ?? DEFAULT_ISOLATED),
      createdAt: now, updatedAt: now,
    };
    await this.registry.set(id, profile);
    this.profiles.set(id, profile);
    return profile;
  }

  // Replace a profile's isolated set wholesale. Non-destructive on re-route: data already written under
  // the old routing stays on disk (a dropped namespace's partition is orphaned, not migrated), matching
  // deleteProfile's leave-in-place semantics.
  async setIsolated(id: string, isolated: string[]): Promise<Profile> {
    const cur = this.profiles.get(id);
    if (cur === undefined) throw new Error(`Profile not found: "${id}"`);
    const next: Profile = {
      ...cur, isolated: this.cleanIsolated(isolated), version: crypto.randomUUID(), updatedAt: new Date().toISOString(),
    };
    await this.registry.cas(id, cur.version, next);
    this.profiles.set(id, next);
    return next;
  }

  // The namespaces a profile may isolate: everything observed so far minus those pinned to base. A lower
  // bound — a namespace only shows once its plugin has touched storage this session.
  availableNamespaces(): string[] {
    return [...this.observed].filter(ns => !ALWAYS_BASE.has(ns)).sort();
  }

  // Dedupe and reject namespaces that can never be isolated (they're forced to base), so accepting them
  // silently wouldn't mislead. Namespaces not yet observed are allowed — the observed set is a lower bound.
  private cleanIsolated(namespaces: string[]): string[] {
    const out = new Set<string>();
    for (const ns of namespaces) {
      if (ALWAYS_BASE.has(ns)) throw new Error(`Namespace "${ns}" is always shared and cannot be isolated.`);
      out.add(ns);
    }
    return [...out];
  }

  // Removes the registry entry; the on-disk partition under `profiles/<id>/` is left in place
  // (non-destructive — recreating the same name reattaches its data). Returns false if absent.
  async deleteProfile(id: string): Promise<boolean> {
    if (!this.profiles.has(id)) return false;
    await this.registry.delete(id);
    this.profiles.delete(id);
    return true;
  }

  // ── Routing ──────────────────────────────────────────────────────────────────────

  // The partition id ('' == base) that should serve (currentPrincipal, namespace).
  private route(namespace: string): string {
    if (ALWAYS_BASE.has(namespace)) return BASE;
    const principal = tryCurrentPrincipal();
    if (principal === undefined) return BASE;
    const profile = this.profiles.get(principal.id);
    if (profile === undefined) return BASE;                 // default/boot/unknown identity → base layout
    const alias = profile.sharedFrom?.[namespace];
    if (alias !== undefined) return alias !== BASE && this.profiles.has(alias) ? alias : BASE;
    return profile.isolated.includes(namespace) ? profile.id : BASE;
  }

  private subStore<T extends { id: string; version: string }>(partId: string, namespace: string): Store<T> {
    const key    = `${partId}::${namespace}`;
    const cached = this.subStores.get(key);
    if (cached !== undefined) return cached as Store<T>;
    const backend = partId === BASE ? this.base : this.partitionFor(partId);
    const store   = backend.createStore<T>(namespace);
    this.subStores.set(key, store);
    return store;
  }

  private partitionFor(id: string): StorageBackend {
    let p = this.partitions.get(id);
    if (p === undefined) {
      p = new FilesystemStorageBackend(join(this.dotData, 'profiles', id));
      this.partitions.set(id, p);
    }
    return p;
  }
}
