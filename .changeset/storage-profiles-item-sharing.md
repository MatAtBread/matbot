---
"@matatbread/matbot-storage-profiles": patch
---

Item-grain sharing between profiles. A new `share` tool — `share({ namespace, id, target })`, plus
`unshare` and `owner` actions — exposes a single stored item the current principal owns (e.g. a
`sessions` conversation) in another profile's partition. The filesystem mechanism is a symlink to the
owner's real file, so the target reads the **live** single source, not a copy: get/query follow it for
free, a dangling link (owner deleted the item) self-tombstones through the store's existing ENOENT
handling, and `unshare` (or a sharee `delete`) just unlinks the link, never the owner's file.

Sharing is read-only in this version: a `set`/`cas` onto a shared-in item throws a branded `ReadOnlyError`
(caught by the turn pump — see the core changeset) rather than clobber the symlink with a forked copy.
Ownership at rest stays **structural** — the single authority is the new
backend predicate `ownerOf(namespace, id): Principal | undefined` (undefined ⇒ owned here), which feeds
both the write-guard and the UI's read-only signal; there is no share registry and no owner field on
items. Only a namespace the target profile isolates can be shared into.
