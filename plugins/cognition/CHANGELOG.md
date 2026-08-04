# @matatbread/matbot-cognition

## 0.3.10

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10
  - @matatbread/matbot-tool-store@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.9
- @matatbread/matbot-tool-store@0.3.9

## 0.3.8

### Patch Changes

- **The Inner voice trigger ships with `{ maxPerTurn: 2, quietTurns: 1 }`**, backfilled onto installs
  seeded before the field existed (skipped if the field was since tuned or cleared).

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8
  - @matatbread/matbot-tool-store@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.7
- @matatbread/matbot-tool-store@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-tool-store@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-tool-store@0.3.5

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
  - @matatbread/matbot-tool-store@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3
  - @matatbread/matbot-tool-store@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2
  - @matatbread/matbot-tool-store@0.3.2

## 0.2.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.9
- @matatbread/matbot-tool-store@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8
  - @matatbread/matbot-tool-store@0.2.8

## 0.2.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.7
- @matatbread/matbot-tool-store@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6
  - @matatbread/matbot-tool-store@0.2.6

## 0.2.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.4
- @matatbread/matbot-tool-store@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.3
- @matatbread/matbot-tool-store@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.2
- @matatbread/matbot-tool-store@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.1
- @matatbread/matbot-tool-store@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.0
- @matatbread/matbot-tool-store@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8
  - @matatbread/matbot-tool-store@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.7
- @matatbread/matbot-tool-store@0.1.7

## 0.1.6

### Patch Changes

- b40c2ec: fix: correct misplaced workspace dependencies

  Several plugins declared type-only `@matatbread/*` imports (the runtime coupling
  is via the service registry, not the import) under `dependencies`, which made a
  packed/published tarball try to install them from the registry:

  - frontend-web: `matbot-skills` → devDependencies
  - cognition: `matbot-skills`, `matbot-triggers` → devDependencies
  - web-principal-user: `matbot-frontend-web` → devDependencies
  - docker-bash: removed `matbot-tool-bash` (entirely unused; the "replaces bash"
    relationship is runtime via the registry, never imported)
  - @matatbread/matbot-plugin-api@0.1.6
  - @matatbread/matbot-tool-store@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.5
- @matatbread/matbot-skills@0.1.5
- @matatbread/matbot-tool-store@0.1.5
- @matatbread/matbot-triggers@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.4
- @matatbread/matbot-skills@0.1.4
- @matatbread/matbot-tool-store@0.1.4
- @matatbread/matbot-triggers@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.3
- @matatbread/matbot-skills@0.1.3
- @matatbread/matbot-tool-store@0.1.3
- @matatbread/matbot-triggers@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.2
- @matatbread/matbot-skills@0.1.2
- @matatbread/matbot-tool-store@0.1.2
- @matatbread/matbot-triggers@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.1
- @matatbread/matbot-skills@0.1.1
- @matatbread/matbot-tool-store@0.1.1
- @matatbread/matbot-triggers@0.1.1
