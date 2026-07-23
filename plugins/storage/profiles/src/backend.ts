import { promises as fs } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Store, FileStore, FileEvent, StorageBackend, Principal, Routed } from '@matatbread/matbot-plugin-api';
import { readOnlyError, createBroadcaster } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-core';
import { FilesystemStorageBackend } from '@matatbread/matbot-storage-filesystem';
import { ProfilesFileStore } from './file-store.js';

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
  // Item-grain sharing. `share` exposes one item the current principal owns in `target`'s partition
  // (this backend links it — a live single source, never a copy); `unshare` reverses that. `ownerOf`
  // reports who owns the item the current principal would read for (namespace, id) — undefined when it is
  // owned here (a real file, absent, or not shared in). The effecting mechanism is backend-private.
  share(namespace: string, id: string, target: string): Promise<void>;
  unshare(namespace: string, id: string, target: string): Promise<void>;
  ownerOf(namespace: string, id: string): Promise<Principal | undefined>;
  // The `WatchVisibility` service surface, exposed here so the plugin can register it. `watchFiles`
  // subscribes to the live origin-stamped file stream (all partitions, dynamic); `visible` is the generic
  // per-connection predicate for any partitioned kind (files, skills, …), keyed on the event's namespace.
  watchFiles(signal?: AbortSignal): AsyncIterable<Routed<FileEvent>>;
  visible(viewer: Principal, namespace: string, origin: Principal | undefined): boolean;
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
    && typeof b.share               === 'function'
    && typeof b.unshare             === 'function'
    && typeof b.ownerOf             === 'function'
    && typeof b.watchFiles          === 'function'
    && typeof b.visible             === 'function'
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

// The single isolation key for the file store (see ProfilesFileStore): files are one axis, not
// per-file-namespace. A profile whose isolated set includes it keeps its whole file area partitioned.
// No document store uses this namespace, so it never collides with a routed createStore.
const FILES_NS = 'files';

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
  // One long-lived, origin-stamped file-event stream fed by a pump per partition (base + each profile,
  // and each profile the moment it's created). watchFiles() just subscribes — so a profile made
  // mid-session is watched live, without the restart a subscribe-time partition snapshot would need.
  private readonly fileEvents                  = createBroadcaster<FileEvent>();
  private readonly lifecycle                   = new AbortController();

  private constructor(dotData: string, base: StorageBackend) {
    this.dotData   = dotData;
    this.base      = base;
    // Files route per-principal on the single `files` axis: the current principal's file area, base
    // (byte-identical to the plain backend) unless the profile isolates files. subStores/partitions are
    // shared with the document side, so a profile's files land under the same profiles/<id>/ root.
    this.fileStore = new ProfilesFileStore(() => {
      const part = this.route(FILES_NS);
      return part === BASE ? this.base.fileStore : this.partitionFor(part).fileStore;
    });
    this.registry  = base.createStore<Profile>(PROFILE_REGISTRY_NS);
    this.watchPartition(undefined, this.base.fileStore);     // base file area (always present)
  }

  static async open(dotData: string): Promise<ProfilesStorageBackend> {
    const base    = await FilesystemStorageBackend.open(dotData);
    const backend = new ProfilesStorageBackend(dotData, base);
    const { items } = await backend.registry.query({});
    for (const p of items) {
      backend.profiles.set(p.id, p);
      for (const ns of p.isolated) backend.observed.add(ns);
      backend.watchPartition({ id: p.id, type: 'user' }, backend.partitionFor(p.id).fileStore);
    }
    for (const ns of DEFAULT_ISOLATED) backend.observed.add(ns);
    backend.observed.add(FILES_NS);                          // offer files as a toggle even before any file op
    return backend;
  }

  // Pump one partition's file events into the shared broadcaster, tagged with its origin, for the backend's
  // lifetime. `origin` undefined = base. The underlying fileStore.watch ends on lifecycle abort (close()).
  private watchPartition(origin: Principal | undefined, store: FileStore): void {
    void (async () => {
      try { for await (const ev of store.watch(this.lifecycle.signal)) this.fileEvents.emit(ev, origin); }
      catch (e) { console.error(`[storage-profiles] file watch for "${origin?.id ?? 'base'}" ended:`, e instanceof Error ? e.message : e); }
    })();
  }

  // ── StorageBackend ─────────────────────────────────────────────────────────────

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    this.observed.add(namespace);
    const pick = (): Store<T> => this.subStore<T>(this.route(namespace), namespace);
    return {
      get:    (id)                  => pick().get(id),
      query:  (q)                   => pick().query(q),
      // delete is exempt from the read-only guard: unlinking a symlink IS un-sharing, and never reaches
      // the owner's file — so a sharee deleting a shared-in item just drops their own link.
      delete: (id, expectedVersion) => pick().delete(id, expectedVersion),
      set:    async (id, value)          => { await this.guardWrite(namespace, id); return pick().set(id, value); },
      cas:    async (id, expected, next) => { await this.guardWrite(namespace, id); return pick().cas(id, expected, next); },
    };
  }

  // Read-only sharing (v1): a set/cas onto an item shared IN from another partition would clobber the
  // symlink with a real file in this partition (writeAtomic's rename), silently forking the owner's data.
  // Refuse it. Only profile partitions ever hold shared-in links (share() rejects a base target), so a
  // base-routed write skips the stat entirely.
  private async guardWrite(namespace: string, id: string): Promise<void> {
    const part = this.route(namespace);
    if (part === BASE) return;
    const owner = await this.sharedOwner(part, namespace, id);
    // Branded (not `new Error`): the turn pump distinguishes it via isReadOnlyError() and surfaces it as a
    // per-turn error instead of crashing on the mandatory persist-at-turn-start write.
    if (owner !== undefined) throw readOnlyError(namespace, id, owner.id);
  }

  async close(): Promise<void> {
    this.lifecycle.abort();                                  // stop every partition's file-watch pump
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
    this.watchPartition({ id, type: 'user' }, this.partitionFor(id).fileStore);   // watch it live — no restart
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

  // ── Sharing (item-grain; filesystem mechanism = symlink) ──────────────────────────

  // Expose one item the current principal owns in `target`'s partition as a symlink to the owner's real
  // file — get()/query() read straight through it, so the sharee sees the live single source. Idempotent.
  async share(namespace: string, id: string, target: string): Promise<void> {
    const sid = this.safeId(id);
    if (ALWAYS_BASE.has(namespace)) throw new Error(`Namespace "${namespace}" is shared globally; individual items can't be shared.`);
    if (this.profiles.get(target) === undefined) throw new Error(`Unknown target profile "${target}".`);
    const sourcePart = this.route(namespace);               // owner = current principal
    const targetPart = this.routeFor(target, namespace);
    if (targetPart === BASE)        throw new Error(`Profile "${target}" does not isolate "${namespace}", so it already reads the shared base data — nothing to share into.`);
    if (targetPart === sourcePart)  throw new Error(`"${id}" already lives in "${target}"'s partition.`);
    const src = join(this.nsDir(sourcePart, namespace), `${sid}.json`);
    const dst = join(this.nsDir(targetPart, namespace), `${sid}.json`);
    const st  = await fs.lstat(src).catch(() => undefined);
    if (st === undefined)     throw new Error(`No "${id}" in "${namespace}" to share.`);
    if (st.isSymbolicLink())  throw new Error(`"${id}" is itself shared in — share it from its owner.`);
    await fs.mkdir(dirname(dst), { recursive: true });
    try { await fs.symlink(src, dst); }
    catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; } // already shared ⇒ idempotent
  }

  // Remove a share by unlinking the target-side symlink. Only ever unlinks a symlink — never the owner's
  // real file — so it is safe even if `target` happens to own a same-id item of its own.
  async unshare(namespace: string, id: string, target: string): Promise<void> {
    const targetPart = this.routeFor(target, namespace);
    if (targetPart === BASE) return;
    const dst = join(this.nsDir(targetPart, namespace), `${this.safeId(id)}.json`);
    const st  = await fs.lstat(dst).catch(() => undefined);
    if (st?.isSymbolicLink()) await fs.unlink(dst);
  }

  // Who owns the item the current principal would read for (namespace, id): undefined when owned here
  // (real file / absent / not shared in), otherwise the source partition's principal (id only — routing
  // keys on principal.id and never reads .type).
  async ownerOf(namespace: string, id: string): Promise<Principal | undefined> {
    return this.sharedOwner(this.route(namespace), namespace, id);
  }

  // ── Partitioned watch (the WatchVisibility service surface) ────────────────────────

  // Subscribe to the live, origin-stamped file-event stream (base + every partition, including profiles
  // created after this call — the pumps feed one broadcaster). Never snapshots a partition set.
  watchFiles(signal?: AbortSignal): AsyncIterable<Routed<FileEvent>> {
    return this.fileEvents.subscribe(signal);
  }

  // Would `viewer` see an event in `namespace` from `origin`? They see it iff they route that namespace to
  // the same partition: route(viewer, ns) === route(origin, ns). Routing BOTH sides (rather than comparing
  // origin.id to a partition) makes it correct whether `origin` is a partition principal (files, tagged by
  // the pump) or the acting principal (skills, stamped at write), and yields "global events for namespaces
  // the viewer hasn't isolated, own-partition only for those it has". `undefined` origin ⇒ base.
  visible(viewer: Principal, namespace: string, origin: Principal | undefined): boolean {
    return this.routeFor(viewer.id, namespace) === this.routeFor(origin?.id, namespace);
  }

  private async sharedOwner(partId: string, namespace: string, id: string): Promise<Principal | undefined> {
    const path = join(this.nsDir(partId, namespace), `${this.safeId(id)}.json`);
    let link: string;
    try {
      const st = await fs.lstat(path);
      if (!st.isSymbolicLink()) return undefined;
      link = await fs.readlink(path);
    } catch { return undefined; }
    return { id: this.partitionOfPath(link), type: 'user' };
  }

  private safeId(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid store id: "${id}"`);
    return id;
  }

  // On-disk directory of a namespace's per-id JSON files for a partition ('' = base). Mirrors the
  // FilesystemStorageBackend layout: base at <dotData>/<ns>, a profile at <dotData>/profiles/<id>/<ns>.
  private nsDir(partId: string, namespace: string): string {
    return partId === BASE ? join(this.dotData, namespace) : join(this.dotData, 'profiles', partId, namespace);
  }

  // The partition id a real on-disk path belongs to: the `<id>` in `.../profiles/<id>/...`, else base.
  private partitionOfPath(p: string): string {
    const marker = `${sep}profiles${sep}`;
    const i = p.indexOf(marker);
    if (i < 0) return BASE;
    return p.slice(i + marker.length).split(sep)[0] ?? BASE;
  }

  // ── Routing ──────────────────────────────────────────────────────────────────────

  // The partition id ('' == base) that should serve (currentPrincipal, namespace).
  private route(namespace: string): string {
    return this.routeFor(tryCurrentPrincipal()?.id, namespace);
  }

  // As route(), for an explicit principal id — lets share() resolve a *target*'s partition without
  // entering its principal scope.
  private routeFor(principalId: string | undefined, namespace: string): string {
    if (ALWAYS_BASE.has(namespace)) return BASE;
    if (principalId === undefined) return BASE;
    const profile = this.profiles.get(principalId);
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
