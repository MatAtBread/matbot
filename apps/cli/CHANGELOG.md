# @matatbread/matbot-cli

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
