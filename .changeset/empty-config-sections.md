---
"@matatbread/matbot-core": patch
---

fix(core/config): tolerate empty `plugins:` / `providers:` sections

A bare `plugins:` (or `providers:`) key with no entries parses to YAML `null`,
which the loader rejected with `"plugins" must be a sequence (list)`. This is the
state `plugin remove` leaves behind when it deletes the last list item, so a config
that had every plugin removed failed to boot. An empty/null section now reads as
empty.
