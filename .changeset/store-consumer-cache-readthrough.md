---
"@matatbread/matbot-triggers": patch
"@matatbread/matbot-skills": patch
"@matatbread/matbot-skills-node": patch
"@matatbread/matbot-tool-skill-compiler": patch
"@matatbread/matbot-cognition": patch
---

Storage consumers no longer keep an in-memory snapshot of their store. `TriggerManager` and `SkillManager`
each used to hold a `Map` loaded once at boot and serve reads from it — which made their read semantics a
property of the backend impl: the snapshot was **principal-blind** (a storage profile isolating `triggers`/
`skills` still saw the base partition's data, because the cache was loaded under the boot principal) and
**stale under any second writer** (a shared DB, another process). It was only accidentally correct while the
backend was a private single-writer filesystem.

Both now read straight through the store proxy, which follows both the live backend and the current
principal's partition: `Triggers.all/get/query` and `SkillManager.all/list/get` return `Promise`s. Skills
keep everything that was *not* a read cache — the KnowledgeIndex projection (`load` re-indexes on boot and on
a storage swap but holds no copy), the detached analysis, and the `watch()` event stream. The skills
system-prompt catalogue contributor is now async (`SystemContextContributor` already permits that).

Caching, where a slow backend needs it, belongs in the StorageBackend, not the consumer — a forthcoming
`CachingStorageBackend` decorator (write-through, optional change-feed else TTL). `skills-node` carries a
large comment marking its `node:fs` watch of the skill directory as the filesystem twin of this same
anti-pattern: a deliberately-kept example of what not to reach for.
