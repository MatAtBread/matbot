# @matatbread/matbot-storage-profiles

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies
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
