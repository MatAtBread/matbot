# @matatbread/matbot-tool-plugin

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
