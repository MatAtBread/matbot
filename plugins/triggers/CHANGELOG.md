# @matatbread/matbot-triggers

## 0.3.5

### Patch Changes

- Screen-phase classifier racing: a `screen` hook can race a verdict against the turn instead of gating the first token on it.

  - **API gaps filled.** `ScreenResult.deferred` — a new `DeferredScreen { claim(): DeferredCorrection | undefined }`
    lets a `screen` hook start expensive work (e.g. a classifier judging the user message) concurrently and
    return immediately, handing the runner a poll handle instead of blocking. The runner polls `claim()` —
    synchronously, never awaited — before each provider call, on every stream event, and just before commit;
    the first time it returns a correction, the runner **discards the uncommitted in-progress response and
    re-runs the loop with the correction folded in** (an in-situ redo: no store pop, no retraction marker).
    The mid-stream poll runs before each event is emitted, so a verdict faster than time-to-first-token is
    caught before any token reaches the frontend; a slower one aborts the in-flight provider request (a
    per-call `AbortController` linked to the turn signal) to stop backend generation. `claim()` is
    exactly-once, so a hook coordinates the in-situ path with its own post-commit fallback.
  - **`DeferredCorrection { ephemeral?, durable? }` and `FollowupResult.retractAndRerun.durable`.** A claimed
    correction — and a post-commit retract — can carry `durable` blocks folded onto the turn's user message
    (persisted, `origin: 'robo'`, carried live as a `robo-user` event) as well as, or instead of, `ephemeral`
    tail-fold blocks, so a durable-context correction keeps its persistence even when the verdict lands
    mid-turn or post-commit. `retractAndRerun.context` is correspondingly optional.
  - **Optional (triggers).** The user-phase classifier now races the turn instead of blocking the first token:
    `screen` kicks off classify+dispatch concurrently and hands the runner a `DeferredScreen`, and the
    correction is delivered on whichever path wins — a pre-first-token grace inject, the runner's in-situ
    restart, or the post-commit `followup` retract (`contextual` fires fold durably, `ephemeral` fires
    tail-fold, on all three). This removes the classifier round-trip from the critical path of the ~90% of
    turns where nothing fires. New `classifierGraceMs` setting (default `0`): `0` is a pure race (no added
    latency); a positive value holds the first token up to that long so a fast classifier injects cleanly
    before generation — one knob spanning fully-responsive to fully-clean. Raced verdicts are traced by a
    `user-insitu-fired` (clean path) or `user-retract-fired` (post-commit) marker.

- Updated dependencies [3e662d0]
- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.5

## 0.3.4

### Patch Changes

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
