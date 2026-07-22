---
"@matatbread/matbot-files-node": patch
---

Fix `FilesystemFileStore.watch()` throwing `ENOENT` when its directory does not yet exist. It now
ensures the directory first (mirroring `put()`/`list()`), so a registered `StorageBackend` acting as the
boot backend — where the host skips its own `.data/files` mkdir — no longer crashes the web frontend at
startup on a fresh data directory.
