# @matatbread/matbot-cli

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies
  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-files-node@0.3.5
  - @matatbread/matbot-provider-anthropic@0.3.5
  - @matatbread/matbot-provider-customer-services@0.3.5
  - @matatbread/matbot-provider-google@0.3.5
  - @matatbread/matbot-provider-openai-compat@0.3.5
  - @matatbread/matbot-storage-filesystem@0.3.5
  - @matatbread/matbot-tool-plugin@0.3.5

- 4276c38: **Optional (providers/chatjimmy).** The ChatJimmy adapter is no longer `private` — it publishes as
  `@matatbread/matbot-provider-chatjimmy` and is a dependency of the CLI, so it appears in the first-run
  setup wizard's provider list (option 5) and resolves by bare package name from an installed matbot as
  well as a source checkout. A hosted llama endpoint: keyless, non-streaming (one `text-delta` per turn),
  text-only and no tool-calling — useful as a low-latency comparison point rather than a
  general-purpose provider.
- Updated dependencies [4276c38]
  - @matatbread/matbot-provider-chatjimmy@0.3.5
  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-files-node@0.3.5
  - @matatbread/matbot-provider-anthropic@0.3.5
  - @matatbread/matbot-provider-customer-services@0.3.5
  - @matatbread/matbot-provider-google@0.3.5
  - @matatbread/matbot-provider-openai-compat@0.3.5
  - @matatbread/matbot-storage-filesystem@0.3.5
  - @matatbread/matbot-tool-plugin@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [36fee95]
- Updated dependencies [c3a1b00]
  - @matatbread/matbot-files-node@0.3.4
  - @matatbread/matbot-core@0.3.4
  - @matatbread/matbot-provider-anthropic@0.3.4
  - @matatbread/matbot-provider-customer-services@0.3.4
  - @matatbread/matbot-provider-google@0.3.4
  - @matatbread/matbot-provider-openai-compat@0.3.4
  - @matatbread/matbot-storage-filesystem@0.3.4
  - @matatbread/matbot-tool-plugin@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.3.3
  - @matatbread/matbot-provider-google@0.3.3
  - @matatbread/matbot-provider-openai-compat@0.3.3
  - @matatbread/matbot-files-node@0.3.3
  - @matatbread/matbot-provider-anthropic@0.3.3
  - @matatbread/matbot-provider-customer-services@0.3.3
  - @matatbread/matbot-storage-filesystem@0.3.3
  - @matatbread/matbot-tool-plugin@0.3.3

## 0.3.2

### Patch Changes

- @matatbread/matbot-core@0.3.2
- @matatbread/matbot-files-node@0.3.2
- @matatbread/matbot-provider-anthropic@0.3.2
- @matatbread/matbot-provider-customer-services@0.3.2
- @matatbread/matbot-provider-openai-compat@0.3.2
- @matatbread/matbot-storage-filesystem@0.3.2
- @matatbread/matbot-tool-plugin@0.3.2

## 0.2.9

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.9
  - @matatbread/matbot-files-node@0.2.9
  - @matatbread/matbot-provider-anthropic@0.2.9
  - @matatbread/matbot-provider-customer-services@0.2.9
  - @matatbread/matbot-provider-openai-compat@0.2.9
  - @matatbread/matbot-storage-filesystem@0.2.9
  - @matatbread/matbot-tool-plugin@0.2.9

## 0.2.8

### Patch Changes

- @matatbread/matbot-core@0.2.8
- @matatbread/matbot-files-node@0.2.8
- @matatbread/matbot-provider-anthropic@0.2.8
- @matatbread/matbot-provider-customer-services@0.2.8
- @matatbread/matbot-provider-openai-compat@0.2.8
- @matatbread/matbot-storage-filesystem@0.2.8
- @matatbread/matbot-tool-plugin@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.7
  - @matatbread/matbot-files-node@0.2.7
  - @matatbread/matbot-provider-anthropic@0.2.7
  - @matatbread/matbot-provider-customer-services@0.2.7
  - @matatbread/matbot-provider-openai-compat@0.2.7
  - @matatbread/matbot-storage-filesystem@0.2.7
  - @matatbread/matbot-tool-plugin@0.2.7

## 0.2.6

### Patch Changes

- @matatbread/matbot-core@0.2.6
- @matatbread/matbot-files-node@0.2.6
- @matatbread/matbot-provider-anthropic@0.2.6
- @matatbread/matbot-provider-customer-services@0.2.6
- @matatbread/matbot-provider-openai-compat@0.2.6
- @matatbread/matbot-storage-filesystem@0.2.6
- @matatbread/matbot-tool-plugin@0.2.6

## 0.2.4

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.4
  - @matatbread/matbot-files-node@0.2.4
  - @matatbread/matbot-provider-anthropic@0.2.4
  - @matatbread/matbot-provider-customer-services@0.2.4
  - @matatbread/matbot-provider-openai-compat@0.2.4
  - @matatbread/matbot-storage-filesystem@0.2.4
  - @matatbread/matbot-tool-plugin@0.2.4

## 0.2.3

### Patch Changes

- 3349bbc: tool-plugin: give a readable error when a github/URL-fetched plugin has an unresolved dependency, and
  document which sources resolve dependency graphs. A raw source-fetch installs one plugin's own files,
  not its dependency graph, so a plugin with a runtime dependency on another package (cognition →
  @matatbread/matbot-tool-store) fails to activate with an opaque ERR_MODULE_NOT_FOUND — which sent the
  model hunting for npm name variations. The `plugin` add flow now names the missing package and states
  the remedy (install the dependency too; from npm for first-party packages, where its own deps resolve),
  explicitly telling the model not to retry name variations; the entry is left in config so it activates
  once the dependency is present. The `plugin` tool description and the `Classified` source type now spell
  out dependency resolution per source: npm/.tgz/git resolve the full tree; local inherits the surrounding
  node_modules; raw github/HTTP fetches only the plugin's own files (deps must be provided separately).
  - @matatbread/matbot-core@0.2.3
  - @matatbread/matbot-files-node@0.2.3
  - @matatbread/matbot-provider-anthropic@0.2.3
  - @matatbread/matbot-provider-customer-services@0.2.3
  - @matatbread/matbot-provider-openai-compat@0.2.3
  - @matatbread/matbot-storage-filesystem@0.2.3
  - @matatbread/matbot-tool-plugin@0.2.3

## 0.2.2

### Patch Changes

- 52faee7: tool-plugin: github/http-fetched plugins now resolve each other by canonical package name. A remote
  plugin is registered in the `.plugins/` symlink farm under its own `package.json` name when fetched,
  so a sibling that imports it (`@matatbread/matbot-skills` from skills-node, `@matatbread/matbot-tool-store`
  from cognition) resolves to the fetched copy — the package name is the canonical identity, independent
  of the source it came from. Previously only host-installed packages were bridged, so inter-dependent
  plugins installed from github failed with `ERR_MODULE_NOT_FOUND`. The host singletons (plugin-api/core)
  are never self-registered, so the singleton boundary is preserved.

  Also: the `plugin` tool now refuses to "install" a host runtime package (`@matatbread/matbot-plugin-api`,
  `@matatbread/matbot-core`, with or without a version suffix) as a plugin, instead of letting it land in
  the config as a bogus, unloadable entry.

  - @matatbread/matbot-core@0.2.2
  - @matatbread/matbot-files-node@0.2.2
  - @matatbread/matbot-provider-anthropic@0.2.2
  - @matatbread/matbot-provider-customer-services@0.2.2
  - @matatbread/matbot-provider-openai-compat@0.2.2
  - @matatbread/matbot-storage-filesystem@0.2.2
  - @matatbread/matbot-tool-plugin@0.2.2

## 0.2.1

### Patch Changes

- 2578f79: Harden the host-shared singletons (plugin-api/core) against duplication in skewed installs, so a
  second physical copy is benign instead of corrupting. Two changes, per an audit of all module-level
  state (see new `docs/duplicate-singletons.md`):

  - **State-shaped singletons now live on `globalThis`.** New `globalSlot()` helper anchors shared
    state under one `Symbol.for` key; the context-switch quiescers/depth/flushing state (reachable by a
    storage plugin) moves there, joining the principal carrier. Duplicate copies share one object
    rather than splitting.

  - **Typed errors are now duck-typed, not classes** (BREAKING for code using them). `MissingSecretError`,
    `IncompatibleRuntimeError`, `NotAPluginError`, `PromptCancelledError` are now plain `Error`s carrying
    a `matbot` brand string. Construct with the `xError()` factory and detect with the `isXError()` guard
    instead of `new XError()` / `instanceof XError` — the brand is identity-independent, so a guard works
    across module copies (where `instanceof` silently returned `false`). The `XError` names remain as
    **types** for annotations and field access. `StoreQueryError` is unchanged (not reached by
    `instanceof` across the boundary).

- 8139163: frontend-web: don't crash the process when an SSE write hits a dead socket. Tearing the server down
  mid-stream (e.g. unloading the frontend-web plugin while a session's `/events` stream is open) makes
  a pending `res.write` emit an asynchronous `'error'` on a later tick — which escapes the request
  handler's try/catch and, with no listener, becomes an unhandled `'error'` event that exits the
  process. The handler now attaches a no-op `'error'` listener to every request/response, so a
  dead-socket write is absorbed (the SSE loop already breaks on `!res.writable`).
  - @matatbread/matbot-core@0.2.1
  - @matatbread/matbot-files-node@0.2.1
  - @matatbread/matbot-provider-anthropic@0.2.1
  - @matatbread/matbot-provider-customer-services@0.2.1
  - @matatbread/matbot-provider-openai-compat@0.2.1
  - @matatbread/matbot-storage-filesystem@0.2.1
  - @matatbread/matbot-tool-plugin@0.2.1

## 0.2.0

### Minor Changes

- ede1b7b: feat(cli): version banner + `--version` flag surfacing resolved singleton versions

  The CLI now prints `matbot vX (core Y, plugin-api Z)` at boot and via `matbot --version`
  (`-v`). The core/plugin-api versions are the ones actually _resolved_ at runtime
  (plugin-api through core, the instance the principal carrier lives in), so a duplicated /
  version-skewed install shows up directly — and prints an explicit "version skew" warning
  with the reinstall remedy instead of failing obscurely later.

- d550b6a: cognition/dream-time: drain the whole backlog per pass instead of one fact.

  Each `dream_time` pass already ranks the entire `remembered_facts` backlog against every skill in a
  single call, but the old pipeline acted only on the oldest fact (plus cluster-mates sharing its
  skill) and threw the rest of the scores away — and only the oldest fact's `weak`/`none` disposition
  was recorded, so every other fact was re-ranked from scratch on every pass. That made throughput one
  fact per pass at `O(facts × skills)` cost each.

  `runOnce` now spends the one ranking on all facts: strong facts are grouped by chosen skill and
  merged up to a per-pass budget, weak facts are all deferred, and dead `none` facts are all retired —
  in the same pass. A per-fact merge failure quarantines just the culprit and the pass carries on with
  the other skills (previously it aborted the whole pass). Partial cluster progress is now committed
  rather than discarded on failure.

  New `cognition_config` tunables: `maxMergesPerPass` (default 20; cap on facts merged across all
  skills per pass) and `maxEnrichmentsPerPass` (default 10; cap on `none` facts given an enriched
  second look, the rest deferred not retired). `maxClusterSize` is now the per-skill cap. `DreamRun`
  records gain `deferred`/`retired`/`quarantined` counts and an `errors` list; `unassignedRemaining`
  now means immediately-actionable (over-budget strong) facts.

### Patch Changes

- d550b6a: Add npm `keywords` to every published package. A shared `matbot` anchor on all of
  them plus a role tag by location (`matbot-plugin-api`, `matbot-core`, `matbot-app`,
  `matbot-plugin`, and `matbot-provider`/`matbot-frontend`/`matbot-storage`). This makes
  the family discoverable via npmjs keyword search (`keywords:matbot`,
  `keywords:matbot,matbot-provider`) rather than relying on the lagging text/org index.
  - @matatbread/matbot-core@0.2.0
  - @matatbread/matbot-files-node@0.2.0
  - @matatbread/matbot-provider-anthropic@0.2.0
  - @matatbread/matbot-provider-customer-services@0.2.0
  - @matatbread/matbot-provider-openai-compat@0.2.0
  - @matatbread/matbot-storage-filesystem@0.2.0
  - @matatbread/matbot-tool-plugin@0.2.0

## 0.1.8

### Patch Changes

- @matatbread/matbot-core@0.1.8
- @matatbread/matbot-files-node@0.1.8
- @matatbread/matbot-provider-anthropic@0.1.8
- @matatbread/matbot-provider-customer-services@0.1.8
- @matatbread/matbot-provider-openai-compat@0.1.8
- @matatbread/matbot-storage-filesystem@0.1.8
- @matatbread/matbot-tool-plugin@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-core@0.1.7
- @matatbread/matbot-files-node@0.1.7
- @matatbread/matbot-provider-anthropic@0.1.7
- @matatbread/matbot-provider-customer-services@0.1.7
- @matatbread/matbot-provider-openai-compat@0.1.7
- @matatbread/matbot-storage-filesystem@0.1.7
- @matatbread/matbot-tool-plugin@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [b40c2ec]
  - @matatbread/matbot-core@0.1.6
  - @matatbread/matbot-files-node@0.1.6
  - @matatbread/matbot-provider-anthropic@0.1.6
  - @matatbread/matbot-provider-openai-compat@0.1.6
  - @matatbread/matbot-storage-filesystem@0.1.6
  - @matatbread/matbot-tool-plugin@0.1.6
  - @matatbread/matbot-provider-customer-services@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [84397a6]
  - @matatbread/matbot-tool-plugin@0.1.5
  - @matatbread/matbot-core@0.1.5
  - @matatbread/matbot-files-node@0.1.5
  - @matatbread/matbot-provider-anthropic@0.1.5
  - @matatbread/matbot-provider-customer-services@0.1.5
  - @matatbread/matbot-provider-openai-compat@0.1.5
  - @matatbread/matbot-storage-filesystem@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [7ea2a82]
  - @matatbread/matbot-tool-plugin@0.1.4
  - @matatbread/matbot-core@0.1.4
  - @matatbread/matbot-files-node@0.1.4
  - @matatbread/matbot-provider-anthropic@0.1.4
  - @matatbread/matbot-provider-customer-services@0.1.4
  - @matatbread/matbot-provider-openai-compat@0.1.4
  - @matatbread/matbot-storage-filesystem@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [fe27c9f]
  - @matatbread/matbot-tool-plugin@0.1.3
  - @matatbread/matbot-core@0.1.3
  - @matatbread/matbot-files-node@0.1.3
  - @matatbread/matbot-provider-anthropic@0.1.3
  - @matatbread/matbot-provider-customer-services@0.1.3
  - @matatbread/matbot-provider-openai-compat@0.1.3
  - @matatbread/matbot-storage-filesystem@0.1.3

## 0.1.2

### Patch Changes

- f9f193c: Fix first-run setup on an npm install. The CLI now bundles the provider adapters
  (anthropic, openai-compat, customer-services) as dependencies, discovers them via
  module resolution instead of a monorepo-only directory scan, and writes the
  provider's package name as `module:` in matbot.yaml (resolves in both an install
  and the workspace). Previously `matbot` aborted with "No provider packages found".
- 55ab48d: Suppress the experimental `stripTypeScriptTypes` warning that the loader otherwise
  prints on every plugin load. Only that one warning is filtered; all others pass through.
  - @matatbread/matbot-core@0.1.2
  - @matatbread/matbot-files-node@0.1.2
  - @matatbread/matbot-provider-anthropic@0.1.2
  - @matatbread/matbot-provider-customer-services@0.1.2
  - @matatbread/matbot-provider-openai-compat@0.1.2
  - @matatbread/matbot-storage-filesystem@0.1.2
  - @matatbread/matbot-tool-plugin@0.1.2

## 0.1.1

### Patch Changes

- 0f863be: Strip TypeScript types in the CLI loader so published packages run. Node's native
  type stripper refuses `.ts` files under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which broke `npx matbot` from an
  npm install. `ts-hooks.js` now strips types itself in a `load` hook (via
  `module.stripTypeScriptTypes`), so installed raw-`.ts` packages load the same as
  workspace ones.
  - @matatbread/matbot-core@0.1.1
  - @matatbread/matbot-files-node@0.1.1
  - @matatbread/matbot-storage-filesystem@0.1.1
  - @matatbread/matbot-tool-plugin@0.1.1
