---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-core': patch
'@matatbread/matbot-storage-filesystem': patch
'@matatbread/matbot-sessions': patch
'@matatbread/matbot-frontend-web': patch
---

**`StoreQuery.immutable`** — the caller's promise not to mutate the returned documents, freeing a
backend to hand back shared instances. A pure optimisation hint: a backend may ignore it and nothing
changes. Set it only where the promise is kept — a read-modify-write path must not.

`FilesystemStore` honours it with a parse cache validated by a fresh `stat` (mtime + size) on every
query, so a document written by another process invalidates exactly like a local one and a stale
entry cannot outlive the stat that disagrees with it; writes through the store additionally drop
their own entry. Bounded at 64 MB of source bytes, evicting least-recently-used.

`session_action` `list` and `query` set it. Listing sessions had to read and parse every session
document whole — every message of every conversation — to produce four summary fields per row:
591ms for 52MB across 213 sessions on every sidebar refresh, now 6ms once warm.
