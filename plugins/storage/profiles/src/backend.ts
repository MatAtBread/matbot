import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs, type Dirent } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Store, FileStore, StorageBackend, Principal, Notifier, VisibilityQuery } from '@matatbread/matbot-plugin-api';
import { readOnlyError, ItemChangeKind } from '@matatbread/matbot-plugin-api';
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
  // Every item in `namespace` that is shared INTO the current principal's partition, mapped to its owner
  // profile id — the bulk form of `ownerOf` (the `owner` action with `id:'*'`). Read from the in-memory
  // shared-in set, so a UI can gate a whole file/session list's share affordance in one round-trip.
  sharedInOwners(namespace: string): Promise<Record<string, string>>;
  // Duplicate an item (or `'*'` = the whole namespace) into `target`'s partition as a real, independent
  // copy the target fully owns — unlike `share`'s live read-only link. Item ids are preserved (a fresh
  // isolated partition keeps intra-set references valid); a shared-in source is dereferenced to its live
  // content. Skills route through the SkillManager (not this backend) so the copy is indexed + evented.
  copy(namespace: string, id: string, target: string): Promise<void>;
  // The `WatchVisibility` service surface, exposed here so the plugin can register it: the generic
  // per-connection predicate for any partitioned kind (files, skills, …), keyed on the event's namespace.
  visible(q: VisibilityQuery): boolean;
  // The `FilePartition` service surface, likewise. The router is the only thing that can answer which
  // area a write landed in, so anything minting an out-of-band address for a file (a URL) asks here
  // instead of inferring it from the principal — which is not the same question (see FilePartition).
  filePartition(): string | undefined;
  enterFilePartition<T>(token: string, fn: () => Promise<T>): Promise<T>;
  // Hand the backend the notification bus. Share/unshare/copy change what a partition can see without
  // touching a Store, so they announce themselves — but the backend is opened by the
  // boot pre-scan, before a machine exists, so the bus is attached from setup() rather than injected.
  attachNotifier(notifier: Notifier): void;
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
    && typeof b.sharedInOwners      === 'function'
    && typeof b.copy                === 'function'
    && typeof b.visible             === 'function'
    && typeof b.filePartition       === 'function'
    && typeof b.enterFilePartition  === 'function'
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

// The slice of a file's sidecar meta that locates its data file on disk (mirrors the filesystem file
// store's own layout resolution). `dataFile` = new anonymous entry; `id` present = legacy anonymous
// (data at `<id>.data`); neither = named entry (data path === the id).
interface FileMeta { dataFile?: string; id?: string }

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
  // Per (partition, namespace) set of item ids symlinked IN from another partition — i.e. the items shared
  // into that profile. visible()'s OR-clause reads it so an owner's edit to a shared-in item reaches the
  // sharee's firehose connection without an fs.lstat per event (visible runs sync, per conn × event). Built
  // eagerly at open() by scanning each partition for symlinks, then maintained on every share/unshare.
  private readonly sharedIn                    = new Map<string, Set<string>>();
  // The file area pinned by enterFilePartition(), overriding the ambient route for `files` only. Async
  // context rather than a field: reads served under a pin interleave with ordinary turns.
  private readonly pinnedFiles                 = new AsyncLocalStorage<string>();
  // Set by the plugin's setup() — open() runs during the boot pre-scan, before any machine exists, so
  // the bus arrives later. Absent (pre-setup, or a host with no notifier) ⇒ share/copy stay silent.
  private notifier: Notifier | undefined;

  private constructor(dotData: string, base: StorageBackend) {
    this.dotData   = dotData;
    this.base      = base;
    // Files route per-principal on the single `files` axis: the current principal's file area, base
    // (byte-identical to the plain backend) unless the profile isolates files. subStores/partitions are
    // shared with the document side, so a profile's files land under the same profiles/<id>/ root.
    this.fileStore = new ProfilesFileStore(() => {
      const part = this.route(FILES_NS);
      if (part === BASE) return this.base.fileStore;        // base area: byte-identical, never guarded
      return this.guardedFileStore(part, this.partitionFor(part).fileStore);
    });
    this.registry  = base.createStore<Profile>(PROFILE_REGISTRY_NS);
  }

  static async open(dotData: string): Promise<ProfilesStorageBackend> {
    const base    = await FilesystemStorageBackend.open(dotData);
    const backend = new ProfilesStorageBackend(dotData, base);
    const { items } = await backend.registry.query({});
    for (const p of items) {
      backend.profiles.set(p.id, p);
      for (const ns of p.isolated) backend.observed.add(ns);
      await backend.scanSharedIn(p.id);
      await backend.scanSharedInFiles(p.id);
    }
    for (const ns of DEFAULT_ISOLATED) backend.observed.add(ns);
    backend.observed.add(FILES_NS);                          // offer files as a toggle even before any file op
    return backend;
  }

  /** Hand the backend the notification bus once a machine exists (see {@link notifier}). */
  attachNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  // Announce a share/unshare/copy to the bus. These mutate a partition's *visible set* without ever
  // passing through a Store or the file area's watch pump, so they are invisible to every other signal —
  // this is the only notice a sharee's list gets that an item arrived or left. `principal` is the
  // partition whose view changed (the target), not the actor, because that is what decides who re-lists.
  private announce(operation: 'saved' | 'deleted', source: string, namespace: string, id: string, partition: string): void {
    if (partition === BASE) return;
    this.notifier?.notify({
      kind: ItemChangeKind, source, operation, namespace, id,
      principal: { id: partition, type: 'user' },
    });
  }

  // ── StorageBackend ─────────────────────────────────────────────────────────────

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    this.observed.add(namespace);
    const pick = (): Store<T> => this.subStore<T>(this.route(namespace), namespace);
    return {
      get:    (id)                  => pick().get(id),
      query:  (q)                   => pick().query(q),
      // Deleting an item shared IN is un-sharing it: it drops this partition's link and never reaches the
      // owner's document. Effected here rather than at the caller — the API surface is unchanged (a delete
      // is a delete; profiles need not even be loaded), and only this layer can tell the two apart.
      delete: (id, expectedVersion) => this.deleteOrUnshare(namespace, id, expectedVersion),
      set:    async (id, value)          => { await this.guardWrite(namespace, id); return pick().set(id, value); },
      cas:    async (id, expected, next) => { await this.guardWrite(namespace, id); return pick().cas(id, expected, next); },
    };
  }

  /**
   * The namespaces the CURRENT principal would actually read — this backend routes per namespace, so
   * there is no single directory to list. Candidates are gathered from every partition this principal
   * can reach (base, its own, and any it aliases into), then each is kept only if its own `route`
   * sends it to a partition that really holds it. Listing the union unfiltered would report another
   * profile's isolated namespace as present here, which is the thing partitioning exists to prevent.
   *
   * Degrades with the layer below: if the base backend cannot enumerate, neither can this, and a
   * partition that cannot is treated as unfiltered rather than empty.
   */
  async namespaces(): Promise<string[]> {
    const principalId = tryCurrentPrincipal()?.id;
    const profile     = principalId !== undefined ? this.profiles.get(principalId) : undefined;

    const candidates = new Set<string>(await this.base.namespaces?.() ?? []);
    for (const part of [profile?.id, ...Object.values(profile?.sharedFrom ?? {})]) {
      if (part === undefined || part === BASE) continue;
      for (const ns of await this.partitionFor(part).namespaces?.() ?? []) candidates.add(ns);
    }

    const out: string[] = [];
    for (const ns of candidates) {
      const part    = this.routeFor(principalId, ns);
      const backend = part === BASE ? this.base : this.partitionFor(part);
      const held    = await backend.namespaces?.();
      if (held === undefined || held.includes(ns)) out.push(ns);
    }
    return out.sort();
  }

  // Read-only sharing (v1): a set/cas onto an item shared IN from another partition would clobber the
  // symlink with a real file in this partition (writeAtomic's rename), silently forking the owner's data.
  // Refuse it. Only profile partitions ever hold shared-in links (share() rejects a base target), so a
  // base-routed write skips the stat entirely.
  // Unlinking the symlink would already leave the owner's document intact, but only by luck: the shared-in
  // cache would keep claiming the item is visible here, and nothing would announce the change. Route it
  // through the same path an explicit unshare takes instead. Reports `true` — from the caller's side the
  // item is gone, which is what it asked for.
  private async deleteOrUnshare(namespace: string, id: string, expectedVersion?: string): Promise<boolean> {
    const part = this.route(namespace);
    if (part !== BASE && this.sharedIn.get(this.sharedInKey(part, namespace))?.has(this.safeId(id))) {
      await this.unshareOne(namespace, id, part);
      return true;
    }
    return this.subStore(part, namespace).delete(id, expectedVersion);
  }

  private async guardWrite(namespace: string, id: string): Promise<void> {
    const part = this.route(namespace);
    if (part === BASE) return;
    const owner = await this.sharedOwner(part, namespace, id);
    // Branded (not `new Error`): the turn pump distinguishes it via isReadOnlyError() and surfaces it as a
    // per-turn error instead of crashing on the mandatory persist-at-turn-start write.
    if (owner !== undefined) throw readOnlyError(namespace, id, owner.id);
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

  // ── Sharing (item-grain; filesystem mechanism = symlink) ──────────────────────────

  // A precise reason a share/copy can't land in `target` for `namespace`. The earlier wording ("already
  // reads the shared base — nothing to share into") wrongly implied the target already had the item; it
  // doesn't, because an isolated namespace is private to its owner unless shared INTO a profile that also
  // isolates it. So report the intersection of the two profiles' isolated sets (the only shareable axes),
  // and — when the namespace isn't an isolatable axis at all — steer a mis-typed file share (the common
  // `workspace` ≠ `files` slip) to the `files` axis. Only called with a live directory, so it never has to
  // account for the profile plugin being absent.
  private cannotShareInto(action: 'share' | 'copy', namespace: string, target: string): string {
    const targetIso  = this.profiles.get(target)?.isolated ?? [];
    const myId       = tryCurrentPrincipal()?.id;
    const myIso      = (myId !== undefined ? this.profiles.get(myId)?.isolated : undefined) ?? [];
    const both       = myIso.filter(n => targetIso.includes(n) && !ALWAYS_BASE.has(n));
    const isolatable = new Set([...this.availableNamespaces(), ...targetIso, ...myIso]);
    const hint = isolatable.has(namespace) ? ''
      : ` Note: "${namespace}" is not an isolatable namespace — to ${action} a stored FILE (including a workspace file) use namespace "files" with id set to the file's path, not the file's content namespace.`;
    const common = both.length
      ? `The only namespaces you can ${action} with "${target}" are the ones you BOTH isolate: ${both.join(', ')}.`
      : `You and "${target}" isolate no namespace in common ("${target}" isolates: ${targetIso.join(', ') || 'nothing'}), so there is nothing to ${action} between you.`;
    return `"${target}" doesn't isolate "${namespace}", so it has no private "${namespace}" partition to ${action} into and cannot see your isolated "${namespace}" items. ${common}${hint}`;
  }

  // Expose one item the current principal owns in `target`'s partition as a symlink to the owner's real
  // file — get()/query() read straight through it, so the sharee sees the live single source. Idempotent.
  // `id` may be a single item or `'*'` — the whole source namespace, each item linked in turn (idempotent;
  // source-side symlinks, i.e. items themselves shared in, are skipped rather than errored).
  async share(namespace: string, id: string, target: string): Promise<void> {
    if (ALWAYS_BASE.has(namespace)) throw new Error(`Namespace "${namespace}" is shared globally; individual items can't be shared.`);
    if (this.profiles.get(target) === undefined) throw new Error(`Unknown target profile "${target}".`);
    const sourcePart = this.route(namespace);               // owner = current principal
    const targetPart = this.routeFor(target, namespace);
    if (targetPart === BASE)        throw new Error(this.cannotShareInto('share', namespace, target));
    if (targetPart === sourcePart)  throw new Error(`"${id}" already lives in "${target}"'s partition.`);
    if (namespace === FILES_NS) {
      const glob = id === '*';
      const ids  = glob ? await this.listFileIds(this.nsDir(sourcePart, FILES_NS)) : [id];
      for (const fid of ids) await this.shareFile(fid, sourcePart, targetPart, glob);
      return;
    }
    const glob = id === '*';
    const ids  = glob ? await this.docIds(sourcePart, namespace) : [id];
    for (const one of ids) await this.shareDoc(one, namespace, sourcePart, targetPart, glob);
  }

  // Link one document into the target as a symlink to the owner's real `<id>.json`. `glob` (the `*` path)
  // skips an already-shared-in source rather than erroring on it.
  private async shareDoc(id: string, namespace: string, sourcePart: string, targetPart: string, glob: boolean): Promise<void> {
    const sid = this.safeId(id);
    const src = join(this.nsDir(sourcePart, namespace), `${sid}.json`);
    const dst = join(this.nsDir(targetPart, namespace), `${sid}.json`);
    const st  = await fs.lstat(src).catch(() => undefined);
    if (st === undefined)    { if (glob) return; throw new Error(`No "${id}" in "${namespace}" to share.`); }
    if (st.isSymbolicLink()) { if (glob) return; throw new Error(`"${id}" is itself shared in — share it from its owner.`); }
    await fs.mkdir(dirname(dst), { recursive: true });
    try { await fs.symlink(src, dst); }
    catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; } // already shared ⇒ idempotent
    this.noteSharedIn(targetPart, namespace, sid);
    this.announce('saved', 'share', namespace, sid, targetPart);
  }

  // Remove a share by unlinking the target-side symlink. Only ever unlinks a symlink — never the owner's
  // real file — so it is safe even if `target` happens to own a same-id item of its own. `id === '*'`
  // unlinks every shared-in symlink the namespace holds in the target partition.
  async unshare(namespace: string, id: string, target: string): Promise<void> {
    const targetPart = this.routeFor(target, namespace);
    if (targetPart === BASE) return;
    const ids = id === '*' ? [...(this.sharedIn.get(this.sharedInKey(targetPart, namespace)) ?? [])] : [id];
    for (const one of ids) await this.unshareOne(namespace, one, targetPart);
  }

  private async unshareOne(namespace: string, id: string, targetPart: string): Promise<void> {
    if (namespace === FILES_NS) return this.unshareFile(id, targetPart);
    const sid = this.safeId(id);
    const dst = join(this.nsDir(targetPart, namespace), `${sid}.json`);
    const st  = await fs.lstat(dst).catch(() => undefined);
    if (st?.isSymbolicLink()) await fs.unlink(dst);
    this.dropSharedIn(targetPart, namespace, sid);
    this.announce('deleted', 'unshare', namespace, sid, targetPart);
  }

  // Who owns the item the current principal would read for (namespace, id): undefined when owned here
  // (real file / absent / not shared in), otherwise the source partition's principal (id only — routing
  // keys on principal.id and never reads .type).
  async ownerOf(namespace: string, id: string): Promise<Principal | undefined> {
    const part = this.route(namespace);
    return namespace === FILES_NS
      ? this.sharedFileOwner(part, id)
      : this.sharedOwner(part, namespace, id);
  }

  // Owners of every shared-in item in the current partition's namespace, in one pass. The shared-in id set
  // is already in memory (built at open(), maintained on share/unshare); resolving each owner reads the one
  // symlink per shared-in item — bounded by the (typically small) shared-in set, never the whole namespace.
  async sharedInOwners(namespace: string): Promise<Record<string, string>> {
    const part = this.route(namespace);
    const ids  = this.sharedIn.get(this.sharedInKey(part, namespace));
    const out: Record<string, string> = {};
    if (ids === undefined) return out;
    for (const id of ids) {
      const owner = namespace === FILES_NS
        ? await this.sharedFileOwner(part, id)
        : await this.sharedOwner(part, namespace, id);
      if (owner !== undefined) out[id] = owner.id;
    }
    return out;
  }

  // A file is a PAIR on disk — a data file plus its `<id>.meta.json` sidecar — so sharing one links both
  // (documents are a single `<id>.json`). The data path is derived from the sidecar exactly as the
  // filesystem file store does: `dataFile` for new anonymous entries, `<id>.data` for legacy anonymous,
  // else the id itself for named files (whose id mirrors the on-disk name and may be nested → `/`).
  private async shareFile(id: string, sourcePart: string, targetPart: string, glob = false): Promise<void> {
    const fid     = this.safeFileId(id);
    const srcArea = this.nsDir(sourcePart, FILES_NS);
    const dstArea = this.nsDir(targetPart, FILES_NS);
    const metaSrc = join(srcArea, `${fid}.meta.json`);
    const st      = await fs.lstat(metaSrc).catch(() => undefined);
    if (st === undefined)    { if (glob) return; throw new Error(`No file "${id}" to share.`); }
    if (st.isSymbolicLink()) { if (glob) return; throw new Error(`"${id}" is itself shared in — share it from its owner.`); }
    const dataRel = this.dataRelOf(fid, JSON.parse(await fs.readFile(metaSrc, 'utf8')) as FileMeta);
    await this.linkInto(join(srcArea, dataRel), join(dstArea, dataRel));
    await this.linkInto(metaSrc,                join(dstArea, `${fid}.meta.json`));
    this.noteSharedIn(targetPart, FILES_NS, fid);
    this.announce('saved', 'share', FILES_NS, fid, targetPart);
  }

  // Drop a shared-in file by unlinking its target-side symlinks (both meta and data). Only ever unlinks
  // symlinks — a real file the target happens to own under the same name is left untouched, matching
  // unshare(). The data path is read back through the (still-linked) meta before the meta link is removed.
  private async unshareFile(id: string, targetPart: string): Promise<void> {
    const fid     = this.safeFileId(id);
    const dstArea = this.nsDir(targetPart, FILES_NS);
    const metaDst = join(dstArea, `${fid}.meta.json`);
    const st      = await fs.lstat(metaDst).catch(() => undefined);
    if (st?.isSymbolicLink()) {
      const dataRel = await fs.readFile(metaDst, 'utf8')
        .then(t => this.dataRelOf(fid, JSON.parse(t) as FileMeta)).catch(() => fid);
      const dataDst = join(dstArea, dataRel);
      if ((await fs.lstat(dataDst).catch(() => undefined))?.isSymbolicLink()) await fs.unlink(dataDst);
      await fs.unlink(metaDst);
    }
    this.dropSharedIn(targetPart, FILES_NS, fid);
    this.announce('deleted', 'unshare', FILES_NS, fid, targetPart);
  }

  // The data file's path relative to a file area, from its sidecar meta (see shareFile).
  private dataRelOf(fid: string, meta: FileMeta): string {
    return meta.dataFile ?? (meta.id !== undefined ? `${fid}.data` : fid);
  }

  // ── Copy (independent duplicate-with-ownership; the `copy` action) ────────────────

  // Copy an item — or `'*'`, the whole namespace — into `target`'s partition as a real, target-owned
  // duplicate (not a symlink). SKILLS are NOT handled here: they must go through the SkillManager (in the
  // caller, under runAs(target)) to be indexed + evented, so the share tool intercepts them before this.
  async copy(namespace: string, id: string, target: string): Promise<void> {
    if (ALWAYS_BASE.has(namespace)) throw new Error(`Namespace "${namespace}" is shared globally; there is nothing to copy into a profile.`);
    if (this.profiles.get(target) === undefined) throw new Error(`Unknown target profile "${target}".`);
    const sourcePart = this.route(namespace);
    const targetPart = this.routeFor(target, namespace);
    if (targetPart === BASE)       throw new Error(this.cannotShareInto('copy', namespace, target));
    if (targetPart === sourcePart) throw new Error(`"${id}" already lives in "${target}"'s partition.`);
    return namespace === FILES_NS
      ? this.copyFiles(id, sourcePart, targetPart)
      : this.copyDocs(id, namespace, sourcePart, targetPart);
  }

  // Document copy: read the source partition's raw store (a shared-in symlink derefs to live content),
  // write THROUGH the target partition's raw store so ids/version are preserved verbatim (bypassing the
  // read-only guard is correct — the target owns this new copy). Writing straight to the sub-store means
  // no partitioned firehose for plain doc kinds (they surface on reload), matching their pre-copy behaviour.
  private async copyDocs(id: string, namespace: string, sourcePart: string, targetPart: string): Promise<void> {
    const src   = this.subStore<{ id: string; version: string }>(sourcePart, namespace);
    const dst   = this.subStore<{ id: string; version: string }>(targetPart, namespace);
    const items = id === '*'
      ? (await src.query({})).items
      : await (async () => {
          const one = await src.get(id);
          if (one === null) throw new Error(`No "${id}" in "${namespace}" to copy.`);
          return [one];
        })();
    for (const item of items) {
      await dst.set(item.id, item);
      this.announce('saved', 'copy', namespace, item.id, targetPart);
    }
  }

  // File copy: duplicate the data + `<id>.meta.json` PAIR with copyFile (which dereferences a symlinked
  // source → an independent copy). The new files land in the target file area, whose watch pump fires the
  // firehose, so a copied file goes live for the target without a reload.
  private async copyFiles(id: string, sourcePart: string, targetPart: string): Promise<void> {
    const srcArea = this.nsDir(sourcePart, FILES_NS);
    const dstArea = this.nsDir(targetPart, FILES_NS);
    const ids = id === '*' ? await this.listFileIds(srcArea) : [this.safeFileId(id)];
    for (const fid of ids) {
      const metaSrc = join(srcArea, `${fid}.meta.json`);
      const raw     = await fs.readFile(metaSrc, 'utf8').catch(() => undefined);
      if (raw === undefined) { if (id === '*') continue; throw new Error(`No file "${id}" to copy.`); }
      const dataRel = this.dataRelOf(fid, JSON.parse(raw) as FileMeta);
      await this.copyInto(join(srcArea, dataRel), join(dstArea, dataRel));
      await this.copyInto(metaSrc,                join(dstArea, `${fid}.meta.json`));
      // The target area's watch pump also sees this write, so a copy may announce twice. Harmless:
      // a notification is an invalidation hint and consumers re-query — never a delta to apply.
      this.announce('saved', 'copy', FILES_NS, fid, targetPart);
    }
  }

  private async copyInto(src: string, dst: string): Promise<void> {
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);                             // follows a symlinked source → real content copy
  }

  // Ids of every document a partition holds in a namespace (real + shared-in), for the `*` fan-out.
  private async docIds(partId: string, namespace: string): Promise<string[]> {
    const { items } = await this.subStore<{ id: string; version: string }>(partId, namespace).query({});
    return items.map(i => i.id);
  }

  // Ids of every file in a partition's file area (recursing named subdirs), for the `*` fan-out. The id is
  // the sidecar's path within the area minus `.meta.json` (nested for named files, flat for anonymous).
  private async listFileIds(area: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        if (e.name.endsWith('.meta.json')) out.push(full.slice(area.length + 1, -'.meta.json'.length));
      }
    };
    await walk(area);
    return out;
  }

  private async linkInto(src: string, dst: string): Promise<void> {
    await fs.mkdir(dirname(dst), { recursive: true });
    try { await fs.symlink(src, dst); }
    catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; } // already shared ⇒ idempotent
  }

  // A read-only guard over a profile partition's file store, symmetric with guardWrite() on the document
  // side: a `put(name)`/`putTemp(name)` onto a file shared IN from another partition would fork the owner's
  // data (writeData's rename replaces the data symlink) and write through the meta symlink to the owner, so
  // it is refused. Anonymous puts (no name → fresh UUID) never collide with a shared-in id, so they pass;
  // get/list delegate straight through; delete of a shared-in file is routed to unshareFile for the
  // same reason the document side routes to unshareOne — the raw unlink would strand the shared-in cache.
  // The shared-in check is the synchronous cache (name === id for named files); the owner is resolved from
  // disk only on the throw path.
  private guardedFileStore(partId: string, inner: FileStore): FileStore {
    const guard = async (name: string | undefined): Promise<void> => {
      if (name === undefined || !this.sharedIn.get(this.sharedInKey(partId, FILES_NS))?.has(name)) return;
      const owner = await this.sharedFileOwner(partId, name);
      throw readOnlyError(FILES_NS, name, owner?.id ?? '');
    };
    return {
      put:       async (name, mime, data, meta) => { await guard(name); return inner.put(name, mime, data, meta); },
      putTemp:   async (name, mime, data)       => { await guard(name); return inner.putTemp(name, mime, data); },
      get:       id       => inner.get(id),
      getByName: (n, ns)  => inner.getByName(n, ns),
      delete:    async id => {
        if (this.sharedIn.get(this.sharedInKey(partId, FILES_NS))?.has(this.safeFileId(id))) {
          return this.unshareFile(id, partId);
        }
        return inner.delete(id);
      },
      list:      f        => inner.list(f),
    };
  }

  // ── Partitioned visibility (the WatchVisibility service surface) ────────────────────

  // Would `viewer` see the change to (`namespace`, `id`) from `origin`? Two ways yes:
  //   1. They route that namespace to the same partition as `origin`: route(viewer,ns) === route(origin,ns).
  //      Routing BOTH sides (not comparing origin.id to a partition) makes it correct whether `origin` is a
  //      partition principal (files, tagged by the pump) or the acting principal (skills, stamped at write),
  //      and yields "global events for namespaces the viewer hasn't isolated, own-partition for those it has".
  //   2. The item is shared INTO the viewer's partition — the owner edits a shared-in item, so origin=owner
  //      routes elsewhere, yet the viewer holds a live link to it and must see the update. Answered from the
  //      eagerly-built sharedIn cache, so no fs stat on this hot per-(conn × event) path.
  //
  // Partition routing is the ONLY policy this backend has, and it is meaningful only for an item-addressed
  // change with an owner. Every other kind — a RegistryChange, a plugin kind carrying progress or an
  // addressed message — has no namespace to route and no owner to route it against, so it is not this
  // backend's call: fail open. These two guards are what the caller's kind gate used to do, and they keep
  // the filtered set identical now that the predicate is consulted for every kind.
  visible(q: VisibilityQuery): boolean {
    const { viewer, namespace, id, origin } = q;
    if (namespace === undefined || id === undefined || origin === undefined) return true;
    const viewerPart = this.routeFor(viewer.id, namespace);
    if (viewerPart === this.routeFor(origin.id, namespace)) return true;
    return this.sharedIn.get(this.sharedInKey(viewerPart, namespace))?.has(id) ?? false;
  }

  // ── FilePartition ────────────────────────────────────────────────────────────────

  // The area the current principal's files resolve to, as an address something outside a principal scope
  // can replay (a URL). Base reads back as `undefined`: a bare path already reaches it, and stamping the
  // base with a token would make an ordinary file look partitioned — the bug this pair exists to end.
  filePartition(): string | undefined {
    const part = this.route(FILES_NS);
    return part === BASE ? undefined : part;
  }

  // The inverse, pinned rather than re-routed: entering the token's principal would run the token back
  // through routeFor, and one alias hop later (`sharedFrom`) that can land in a DIFFERENT area than the
  // one the token named. An address must resolve to what it addressed, so the pin short-circuits routing
  // — for `files` alone, leaving every document store in the scope routed as usual.
  enterFilePartition<T>(token: string, fn: () => Promise<T>): Promise<T> {
    return this.pinnedFiles.run(token, fn);
  }

  // ── Shared-in cache (feeds visible()'s OR-clause) ─────────────────────────────────

  private sharedInKey(partId: string, namespace: string): string {
    return `${partId}::${namespace}`;
  }

  private noteSharedIn(partId: string, namespace: string, id: string): void {
    const key = this.sharedInKey(partId, namespace);
    let set = this.sharedIn.get(key);
    if (set === undefined) { set = new Set(); this.sharedIn.set(key, set); }
    set.add(id);
  }

  private dropSharedIn(partId: string, namespace: string, id: string): void {
    this.sharedIn.get(this.sharedInKey(partId, namespace))?.delete(id);
  }

  // Seed the shared-in cache for a profile by scanning its partition for document symlinks (each a
  // shared-in item). `<ns>/<id>.json` symlinks only; the `files` area is a coarse pair-based axis handled
  // by its own mechanism (Task E), so it is skipped here. Best-effort — a missing partition dir is empty.
  private async scanSharedIn(partId: string): Promise<void> {
    const root = join(this.dotData, 'profiles', partId);
    let nsDirs: Dirent[];
    try { nsDirs = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const nsDir of nsDirs) {
      if (!nsDir.isDirectory() || nsDir.name === FILES_NS) continue;
      let entries: Dirent[];
      try { entries = await fs.readdir(join(root, nsDir.name), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isSymbolicLink() && e.name.endsWith('.json')) {
          this.noteSharedIn(partId, nsDir.name, e.name.slice(0, -'.json'.length));
        }
      }
    }
  }

  // Seed the shared-in cache for a profile's FILE area: any `<...>.meta.json` sidecar that is a symlink is
  // a shared-in file (its id is the sidecar's path within the area, minus the suffix — nested for named
  // files). The document scan (scanSharedIn) skips the files dir precisely because its shape differs.
  private async scanSharedInFiles(partId: string): Promise<void> {
    const root = this.nsDir(partId, FILES_NS);
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        if (e.isSymbolicLink() && e.name.endsWith('.meta.json')) {
          const rel = full.slice(root.length + 1, -'.meta.json'.length);
          this.noteSharedIn(partId, FILES_NS, rel);
        }
      }
    };
    await walk(root);
  }

  // Owner of a shared-in file: undefined unless its sidecar symlink resolves into another partition.
  private async sharedFileOwner(partId: string, id: string): Promise<Principal | undefined> {
    const path = join(this.nsDir(partId, FILES_NS), `${this.safeFileId(id)}.meta.json`);
    let link: string;
    try {
      const st = await fs.lstat(path);
      if (!st.isSymbolicLink()) return undefined;
      link = await fs.readlink(path);
    } catch { return undefined; }
    return { id: this.partitionOfPath(link), type: 'user' };
  }

  // A file id may be a nested name (`reports/2024.txt`) — unlike a document id (safeId) it can contain
  // `/` and `.`. Reject only what would escape the file area: absolute paths and any `..`/empty segment.
  private safeFileId(id: string): string {
    if (id.length === 0 || id.startsWith('/') || id.split('/').some(s => s === '' || s === '..')) {
      throw new Error(`Invalid file id: "${id}"`);
    }
    return id;
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
    if (namespace === FILES_NS) {
      const pinned = this.pinnedFiles.getStore();
      if (pinned !== undefined) return pinned;
    }
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
