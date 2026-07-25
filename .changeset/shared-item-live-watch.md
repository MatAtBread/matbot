---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-skills": patch
"@matatbread/matbot-storage-profiles": patch
"@matatbread/matbot-frontend-web": patch
---

Shared-item live watch: an owner's edit to an item shared **into** another profile now reaches the
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
