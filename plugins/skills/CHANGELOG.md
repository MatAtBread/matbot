# @matatbread/matbot-skills

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

- 8411e61: Storage consumers no longer keep an in-memory snapshot of their store. `TriggerManager` and `SkillManager`
  each used to hold a `Map` loaded once at boot and serve reads from it — which made their read semantics a
  property of the backend impl: the snapshot was **principal-blind** (a storage profile isolating `triggers`/
  `skills` still saw the base partition's data, because the cache was loaded under the boot principal) and
  **stale under any second writer** (a shared DB, another process). It was only accidentally correct while the
  backend was a private single-writer filesystem.

  Both now read straight through the store proxy, which follows both the live backend and the current
  principal's partition: `Triggers.all/get/query` and `SkillManager.all/list/get` return `Promise`s. Skills
  keep everything that was _not_ a read cache — the KnowledgeIndex projection (`load` re-indexes on boot and on
  a storage swap but holds no copy), the detached analysis, and the `watch()` event stream. The skills
  system-prompt catalogue contributor is now async (`SystemContextContributor` already permits that).

  Caching, where a slow backend needs it, belongs in the StorageBackend, not the consumer — a forthcoming
  `CachingStorageBackend` decorator (write-through, optional change-feed else TTL). `skills-node` carries a
  large comment marking its `node:fs` watch of the skill directory as the filesystem twin of this same
  anti-pattern: a deliberately-kept example of what not to reach for.

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2

## 0.2.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8

## 0.2.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6

## 0.2.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.7

## 0.1.6

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.1
