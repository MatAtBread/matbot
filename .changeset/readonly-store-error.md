---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-core": patch
---

New branded `ReadOnlyError` (`readOnlyError()` factory + `isReadOnlyError()` guard, alongside the other
brand-based typed errors) for a `Store` write rejected because the current principal does not own the
item — e.g. a session shared read-only from another profile's partition.

The turn pump now catches it around the persist-at-turn-start write in `SessionRunner`: a read-only
rejection is surfaced as a per-turn `error` event and the submission is dropped, instead of escaping the
detached pump and crashing the host. Any other write failure stays fatal as before. Detection uses the
brand guard, never `instanceof`, so it holds across a skewed/duplicated plugin-api install.
