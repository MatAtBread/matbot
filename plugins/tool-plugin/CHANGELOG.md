# @matatbread/matbot-tool-plugin

## 0.2.7

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.7
  - @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6
  - @matatbread/matbot-core@0.2.6

## 0.2.4

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.4
  - @matatbread/matbot-plugin-api@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-core@0.2.3
- @matatbread/matbot-plugin-api@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-core@0.2.2
- @matatbread/matbot-plugin-api@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-core@0.2.1
- @matatbread/matbot-plugin-api@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-core@0.2.0
- @matatbread/matbot-plugin-api@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8
  - @matatbread/matbot-core@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-core@0.1.7
- @matatbread/matbot-plugin-api@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [b40c2ec]
  - @matatbread/matbot-core@0.1.6
  - @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- 84397a6: fix(tool-plugin): discover_local resolves conditional `exports`

  `resolveExportsMain` only handled a string `exports["."]`; a plugin using the
  conditional form (`{ browser, import, default }`, e.g. frontend-web) resolved to
  `undefined` and was silently skipped during discovery — so a cached/source plugin
  with a browser bundle never appeared in `discover_local`. Now resolves the node
  ESM conditions (node/import/default), skipping browser/require.

  - @matatbread/matbot-core@0.1.5
  - @matatbread/matbot-plugin-api@0.1.5

## 0.1.4

### Patch Changes

- 7ea2a82: Clarify the `plugin` tool's specifier docs: show the raw `github:owner/repo/subdir#ref`
  form for source plugins (a repo subdir), state that the `#path:`/git forms are only for
  fully-packaged published packages, and instruct the model to pass a user-supplied
  specifier verbatim. Prevents the model rewriting a working github specifier into a
  package-manager form that fails on workspace/raw source.
  - @matatbread/matbot-core@0.1.4
  - @matatbread/matbot-plugin-api@0.1.4

## 0.1.3

### Patch Changes

- fe27c9f: When materialising a remote (github/http) plugin, also fetch the concrete files it
  declares in `files` (e.g. static UI assets), not just its import graph. A raw host
  can't be directory-listed, so asset-bearing plugins like frontend-web previously
  fetched their code but none of their runtime assets. Directory and glob entries are
  skipped; missing files warn and are skipped (best-effort).
  - @matatbread/matbot-core@0.1.3
  - @matatbread/matbot-plugin-api@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-core@0.1.2
- @matatbread/matbot-plugin-api@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-core@0.1.1
- @matatbread/matbot-plugin-api@0.1.1
