# @matatbread/matbot-storage-profiles

A profile-aware `StorageBackend` for Node. It composes the filesystem storage primitive and partitions
**selected namespaces** per web principal, so each profile has its own isolated slice of the datastore.

## What it does

- Registers as the boot `StorageBackend` (list it before any plugin whose `setup()` calls `createStore`).
- Routes each store operation on the ambient `currentPrincipal()`:
  - the **default/unknown principal** — and always `settings` — resolve to the **base layout**, byte-identical
    to the plain filesystem backend, so existing data stays put and visible;
  - a **named profile** whose `private` set includes the namespace resolves to `profiles/<id>/<namespace>`.
- Ships a `profile_action` tool (`list` / `create` / `delete`). Its presence is what makes the web UI show its
  profile selector; **selecting** the active profile is a per-browser concern (the web UI stores it locally
  and sends it as the `x-matbot-principal` request header — see `@matatbread/matbot-frontend-web`).

## Lifecycle

A storage backend is the system of record, so at boot the host pre-scan opens it before the services object
exists (list this plugin **first** in `matbot.yaml`, before any plugin whose `setup()` calls `createStore`).

It can also be **hot-added at runtime** — no restart. When loaded after boot, `setup()` opens the backend
and `register('StorageBackend', …)`s it (mirroring the sqlite backend); the swap lands at the next quiescent
edge (immediately when the machine is idle, at the end of the current turn when loaded mid-turn), and
`unloadPlugin` reverts to the host base via the recorded service key. The `profile_action`/`share` tools and
the `WatchVisibility` watch layer resolve the backend live per call, so they start working the moment the
swap lands. Existing data is untouched (the profiles base layout is byte-identical to the plain filesystem).

## Why this is a backend, not a wrapper

It **composes `FilesystemStorageBackend` directly** — one instance rooted at the base layout, one per
profile rooted at `profiles/<id>/` — rather than wrapping whatever `StorageBackend` is active. That is
deliberate, and it is the answer to "why can't I use profiles with SQLite?"

How data is divided by owner is medium-specific. The filesystem expresses it as nested directories; a SQL
backend might use a table prefix, a partition column, or row-level policies; Drive could use folders or
real Drive permissions. There is no general wrapper that could impose one of those compositions on every
backend, so partitioning is a **capability a backend implements**, not a layer over backends.

The shared surface is `ProfileDirectory`, and consumers reach it by duck-typing the *active* backend —
`asProfileDirectory(services.StorageBackend)`, method presence, never `instanceof`, so it survives hot
reload and follows swaps. The check takes `unknown` and is purely structural, so **any** backend exposing
that shape is picked up by the existing `profile_action`/`share` tools and the `WatchVisibility` layer,
with no import from this package and no change to `plugin-api`. A partitioning SQLite backend is therefore
a thing someone can write; it just isn't this plugin.

**Consequence: this plugin does not combine with another storage backend.** Only one backend is ever
active. Configure this alongside (say) `matbot-storage-sqlite` and whichever loses still opens its
database before being discarded, so you get an orphaned `matbot.db` and every write on the filesystem.
The host warns once, naming the displaced plugin — but configure exactly one storage plugin.

## Granularity

The unit of isolation is one whole `createStore(namespace)` bucket. A profile's `private` list is a subset
of the store-backed namespaces (`sessions`, `skills`, `triggers`, `knowledge`, `remembered_facts`, …).
Fresh profiles default to `['sessions']`. `settings` cannot be profiled (it is one shared bucket keyed by
plugin name above the store). Files (`fileStore`) are a separate axis and are not partitioned yet.

## Sharing

`Profile.sharedFrom` maps a namespace to another profile's id (or `''` for base), so two profiles can point
at one namespace's data. It is honoured by the router today; no UI/tooling exposes it yet.

## Not in scope

Real security (any client may assert any profile via the header), files/workspace partitioning, and
authentication on profile selection.
