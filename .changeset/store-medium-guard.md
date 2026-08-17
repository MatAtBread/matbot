---
'@matatbread/matbot-core': patch
---

A store write can no longer cross a `StorageBackend` swap.

Exactly one backend is active and nothing is migrated between them, so a caller that read a document
before a swap and wrote it after was addressing two media with one read-modify-write — and nothing
could see it. Compare-and-swap asks "did this document change?", which the incoming backend answers
about a document it never issued, usually "there is nothing here"; an unconditional `set` then
recreated the previous backend's document inside its replacement, and a session had silently migrated.
It is reachable wherever a read and a write straddle the swap — an HTTP tool call always could, and
deferred quiescent-edge work now can too.

`mediumGuard` (`@matatbread/matbot-core/storage-base`, wrapped around each store proxy by both hosts)
puts the check where the consequence lands rather than asking every caller to know something only
storage knows. The version is the only token tying a read to its write, so it carries the medium:
stamped on the way out, checked and stripped on the way in — stripped because most write-backs reuse
the version they read (`store.set(id, { ...doc, title })`), and a persisted stamp would be stamped
again on the next read. An unstamped version is always accepted, being a document the caller minted
rather than read. A stale `cas` returns `{ ok: false }`, the loss every caller already handles; a stale
`set` throws, having no other channel.
