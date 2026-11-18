---
"@matatbread/matbot-gate-fs-node": patch
---

A symlink cycle is asked about under the real path of its directory. It was asked about as spelled, so on macOS a path under `/var` (a link to `/private/var`) was a different subject from the `/private/var/…` a standing answer names, and that answer did not apply. The call still fails with `ELOOP`.
