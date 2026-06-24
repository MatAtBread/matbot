---
"@matatbread/matbot-tool-plugin": patch
---

When materialising a remote (github/http) plugin, also fetch the concrete files it
declares in `files` (e.g. static UI assets), not just its import graph. A raw host
can't be directory-listed, so asset-bearing plugins like frontend-web previously
fetched their code but none of their runtime assets. Directory and glob entries are
skipped; missing files warn and are skipped (best-effort).
