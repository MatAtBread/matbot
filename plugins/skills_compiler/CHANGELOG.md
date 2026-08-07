# @matatbread/matbot-tool-skill-compiler

## 0.4.2

### Patch Changes

- One shared contract for the `plugin` and `provider` tools, and named result shapes that can be augmented.

  Both tools have a node and a browser implementation, and each declared its own `ToolContracts` arm. A registry key is registered by declaration merging, so two declarations are legal only while identical — these were not, and `buildMatbotToolsDts` never read the Program's diagnostics, so one won on file order and its shape was emitted as the contract. In any tree containing `plugins/`, the browser shapes won, and node's generated code was graded against them: the check loop rejected `providers[].hasCredentials` (what node returns) and accepted `providers[].hasKey` (`undefined` at runtime).

  Both now declare `PluginToolContract` / `ProviderToolContract` from plugin-api. Node's names win, so the browser tool renames `hasKey` → `hasCredentials`, `adapter` → `module`, `ProviderRow` → `ProviderSummary`, and takes `ModelParameters` for `parameters`. `FailedPlugin` moves from core to plugin-api (still re-exported from core). Result shapes are named, exported interfaces, so a host overriding a builtin tool can augment them instead of being unable to describe its own return.

  Duplicate registry declarations are now reported rather than silently resolved.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2
  - @matatbread/matbot-tool-types@0.4.2

## 0.3.10

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10
  - @matatbread/matbot-tool-types@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.9
- @matatbread/matbot-tool-types@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8
  - @matatbread/matbot-tool-types@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.7
- @matatbread/matbot-tool-types@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-tool-types@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-tool-types@0.3.5

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
  - @matatbread/matbot-tool-types@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3
  - @matatbread/matbot-tool-types@0.3.3

## 0.3.2

### Patch Changes

- Typed, self-repairing codegen pipeline: ToolProxy trailing catch-all overload (sound `ReturnType`, better bad-call errors, dynamic union dispatch); one worker-hosted checker in tool-types with annotated diagnostics and a structural cast gate (no main-thread block, no fallback); skills_compiler embeds the tool-contract dts in every prompt, threads the interactive prompt channel into demonstrations, distils honestly, verifies installs, and repairs over 4 passes; function-tools enforces lambda's one-argument convention.
- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2
  - @matatbread/matbot-tool-types@0.3.2

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
