---
"@matatbread/matbot-storage-profiles": patch
"@matatbread/matbot-skills": patch
"@matatbread/matbot-frontend-web": patch
---

Partitioned live events now cover skills as well as files, and a profile created mid-session is watched
without a restart.

- **Skills fan-out.** `SkillManager.watch()` now yields origin-stamped events (`Routed<SkillEvent>`, the
  acting principal), and the web firehose filters `skill-changed` per connection just like files. A profile
  that isolates the `skills` namespace sees only its own skill CRUD; profiles that don't still see the
  shared/base skills. (The `SkillManager`'s in-memory catalogue is still principal-blind — a separate,
  deeper fix — but the event stream is now partition-correct.)
- **One generic visibility predicate.** `WatchVisibility` gains `visible(viewer, namespace, origin)` (was a
  file-specific `visibleTo`), defined as `route(viewer, ns) === route(origin, ns)`: routing *both* sides
  makes it correct whether the origin is a partition (files) or the acting principal (skills), and yields
  "global events for namespaces you haven't isolated, own-partition only for those you have".
- **Dynamic partitions — no restart.** The profiles backend now feeds one long-lived, origin-stamped file
  broadcaster from a watch pump per partition, and starts a pump the moment a profile is created — so a
  profile made after the frontend connected receives its file events live. (Previously the partition set was
  snapshotted when the watch began, needing a restart to pick up a new profile.)
- **`profile` tool renamed to `profile_action`** for consistency with the other `*_action` tools.
