# @matatbread/matbot-storage-profiles

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-storage-filesystem@0.3.5

- 86fd3fe: File-item sharing and a `copy` action for the `share` tool — item-grain sharing now spans files, not just
  documents, and gains a duplicate-with-ownership mode.

  - **File sharing.** `share`/`unshare`/`ownerOf` now handle the `files` axis (`id` = the file id): a file
    is a data + `<id>.meta.json` PAIR on disk, so sharing links both into the target's file area (named files
    may be nested → the target subdir is created), reads flow through the symlinks to the owner's live file,
    and `unshare` unlinks the pair. `ownerOf('files', id)` reports the owning profile (the read-only badge
    signal). A shared-in file is **read-only**: a `put`/`putTemp` under the shared name throws `ReadOnlyError`
    (it would fork the data and write through the meta symlink to the owner); anonymous puts and delete pass.
    The shared-in file set is seeded at open() (scanning each partition's file area for `.meta.json` symlinks)
    and feeds both the write-guard and Task B's live-watch OR-clause, so an owner's edit to a shared file
    reaches every sharee's firehose connection.
  - **`copy` action.** A new `action: 'copy'` on the `share` tool writes an independent duplicate the target
    fully owns and can edit (unlike `share`'s read-only link). Item ids are preserved (a fresh isolated
    partition keeps intra-set references valid); a shared-in source is dereferenced to its live content.
    Documents copy through the target partition's store; files copy the data + meta pair (a copied file goes
    live via the target's watch pump); skills route through the `SkillManager` (discovered loosely) under
    `runAs(target)` so the copy is indexed into the KnowledgeIndex and evented, falling back to a structural
    doc copy when skills isn't loaded.
  - **`id: '*'`.** `share`, `unshare`, and `copy` accept `*` to mean the whole namespace — every item in the
    source namespace (share skips items that are themselves shared in; unshare drops all target-side links).
  - **Bulk ownership.** The `owner` action with `id: '*'` returns an `owners` map of every shared-in item in
    the namespace to its owner profile (read from the in-memory shared-in set), so a UI can gate a whole
    file/session list's share affordance in one round-trip instead of one `owner` call per item.
  - **Clearer share/copy failures.** When a target profile doesn't isolate the namespace, the error no longer
    claims it "already reads the shared base data" (which read as "the target already has this item" — false
    for an item in your own isolated partition). It now names the intersection of the two profiles' isolated
    sets (the only namespaces shareable between them) and, when the namespace isn't an isolatable axis at all,
    redirects a mis-typed file share to `namespace: "files"` (the common `workspace` ≠ `files` slip). The tool
    description makes the same isolation-axis-vs-content-namespace distinction explicit.
  - **Web frontend (showcase).** File items in the sidebar gain a share affordance mirroring the session one:
    a share button (targets = profiles that isolate `files`) calling `share` with `namespace: 'files'`, and a
    read-only marker on a file shared in from another profile (share button withheld, delete relabelled
    "Remove from my view"). Since a file opens as raw bytes in a new tab — a surface that can carry no banner
    of its own — the list row is where the state has to read: a shared-in row is tinted, stripe-marked, and
    carries its own always-visible line naming the owner ("shared by …" / "shared globally" · read-only). The
    file list stays profile-agnostic — ownership comes from a single `owner`/`*` call, not the workspace tool.

- 86fd3fe: Shared-item live watch: an owner's edit to an item shared **into** another profile now reaches the
  sharee's live view, and every partitioned CRUD stream is unified behind one self-describing change envelope.

  - **API gaps filled.** New `StoreChange` (plugin-api) — `{ operation: 'saved' | 'deleted'; namespace; id;
detail? }`, the payload half of a `Routed` event. It is the generic, self-describing shape every
    partitioned stream now emits (files, skills, future partitioned stores), carrying its own **routing**
    namespace (`'files'` / `'skills'` / a document namespace — not a file's content sub-namespace, which
    rides in `detail`) and item id. This is exactly what a per-connection visibility filter needs, so the
    frontend firehose no longer hardcodes a per-stream routing namespace.
  - **Breaking (optional service).** `WatchVisibility.visible` gains an `id` parameter —
    `visible(viewer, namespace, id, origin)` — and `watchFiles` now yields `Routed<StoreChange>` (was
    `Routed<FileEvent>`). `SkillManager.watch` yields `Routed<StoreChange>` (the bespoke `SkillEvent` type is
    removed). Only consumers of these newer surfaces (the profiles backend, the web firehose) are affected.
  - **Optional (storage-profiles).** `visible` now returns true not only when viewer and origin route the
    namespace to the same partition, but also when the item is **shared into** the viewer's partition — so an
    owner editing a shared-in item is seen live by every sharee, closing the live-update regression profiles
    introduced. Backed by a per-`(partition, namespace)` shared-in id-set built eagerly at open() (scanning
    partitions for symlinks) and maintained on every `share`/`unshare`, so `visible` stays synchronous with no
    `fs` stat on the hot per-connection path.
  - **Optional (frontend/web).** The `/events` firehose feeds `visible` straight from each self-describing
    `StoreChange` (no per-stream namespace constant); the in-process and HTTP transports both normalise file
    and skill events to the same `StoreChange` shape so the UI reads one shape whichever transport is live.

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-storage-filesystem@0.3.5

## 0.3.4

### Patch Changes

- 53bf4f8: Partitioned live events now cover skills as well as files, and a profile created mid-session is watched
  without a restart.

  - **Skills fan-out.** `SkillManager.watch()` now yields origin-stamped events (`Routed<SkillEvent>`, the
    acting principal), and the web firehose filters `skill-changed` per connection just like files. A profile
    that isolates the `skills` namespace sees only its own skill CRUD; profiles that don't still see the
    shared/base skills. (The `SkillManager`'s in-memory catalogue is still principal-blind — a separate,
    deeper fix — but the event stream is now partition-correct.)
  - **One generic visibility predicate.** `WatchVisibility` gains `visible(viewer, namespace, origin)` (was a
    file-specific `visibleTo`), defined as `route(viewer, ns) === route(origin, ns)`: routing _both_ sides
    makes it correct whether the origin is a partition (files) or the acting principal (skills), and yields
    "global events for namespaces you haven't isolated, own-partition only for those you have".
  - **Dynamic partitions — no restart.** The profiles backend now feeds one long-lived, origin-stamped file
    broadcaster from a watch pump per partition, and starts a pump the moment a profile is created — so a
    profile made after the frontend connected receives its file events live. (Previously the partition set was
    snapshotted when the watch began, needing a restart to pick up a new profile.)
  - **`profile` tool renamed to `profile_action`** for consistency with the other `*_action` tools.

- a3cfbfa: Profile-aware file storage. The backend's `fileStore` is no longer the unprofiled passthrough — it now
  routes every file op (`put`/`get`/`getByName`/`list`/`delete`/`putTemp`/`watch`) to the current
  principal's partition, mirroring how `createStore` routes. Files are a single isolation axis (the
  pseudo-namespace `files`), not per-file-namespace: `get(id)`/`delete(id)` carry no namespace, and a
  file's namespace is a metadata filter rather than a directory, so the whole file area moves together. A
  profile that isolates `files` keeps its area under `profiles/<id>/files`; the default/unknown principal
  and any profile that doesn't isolate it read the base area — byte-identical to before, so existing files
  are untouched. The `files` axis is offered as a toggle in the profile's isolated-namespace editor.

  Cross-partition file watching (a server watching every partition, filtered per connection) is still to
  come — until then a profile that isolates files gets no live file events, and base watching is unchanged.

- ef2b13f: The profiles backend can now be **hot-added at runtime — no restart**. Previously, loading the plugin after
  boot did nothing: it installed its backend only via the boot pre-scan `open()` hook (which a hot load never
  runs) and bailed. It now mirrors the sqlite backend — on hot-load, `setup()` opens the backend and
  `register('StorageBackend', …)`s it (dotData derived from `configPath`), then registers the
  `profile_action`/`share` tools and the `WatchVisibility` watch layer, which resolve the backend live per call
  so they work the moment the swap lands. The swap is applied immediately when the machine is idle and at the
  turn's end when loaded mid-turn; `unloadPlugin` reverts to the host base via the recorded service key.
  Existing data is untouched (the base layout is byte-identical to the plain filesystem backend).
- c3a1b00: Item-grain sharing between profiles. A new `share` tool — `share({ namespace, id, target })`, plus
  `unshare` and `owner` actions — exposes a single stored item the current principal owns (e.g. a
  `sessions` conversation) in another profile's partition. The filesystem mechanism is a symlink to the
  owner's real file, so the target reads the **live** single source, not a copy: get/query follow it for
  free, a dangling link (owner deleted the item) self-tombstones through the store's existing ENOENT
  handling, and `unshare` (or a sharee `delete`) just unlinks the link, never the owner's file.

  Sharing is read-only in this version: a `set`/`cas` onto a shared-in item throws a branded `ReadOnlyError`
  (caught by the turn pump — see the core changeset) rather than clobber the symlink with a forked copy.
  Ownership at rest stays **structural** — the single authority is the new
  backend predicate `ownerOf(namespace, id): Principal | undefined` (undefined ⇒ owned here), which feeds
  both the write-guard and the UI's read-only signal; there is no share registry and no owner field on
  items. Only a namespace the target profile isolates can be shared into.

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4
  - @matatbread/matbot-core@0.3.4
  - @matatbread/matbot-storage-filesystem@0.3.4

## Unreleased

### Optional

- New plugin: a profile-aware `StorageBackend` that partitions selected namespaces (`sessions` by
  default) per web principal over the filesystem layout, with a `profile` CRUD tool. The default
  principal keeps the existing base layout, so existing sessions remain visible.
