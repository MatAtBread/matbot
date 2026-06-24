# @matatbread/matbot-tool-plugin

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
