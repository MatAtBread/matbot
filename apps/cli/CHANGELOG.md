# @matatbread/matbot-cli

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
