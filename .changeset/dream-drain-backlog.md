---
"@matatbread/matbot-cli": minor
---

cognition/dream-time: drain the whole backlog per pass instead of one fact.

Each `dream_time` pass already ranks the entire `remembered_facts` backlog against every skill in a
single call, but the old pipeline acted only on the oldest fact (plus cluster-mates sharing its
skill) and threw the rest of the scores away — and only the oldest fact's `weak`/`none` disposition
was recorded, so every other fact was re-ranked from scratch on every pass. That made throughput one
fact per pass at `O(facts × skills)` cost each.

`runOnce` now spends the one ranking on all facts: strong facts are grouped by chosen skill and
merged up to a per-pass budget, weak facts are all deferred, and dead `none` facts are all retired —
in the same pass. A per-fact merge failure quarantines just the culprit and the pass carries on with
the other skills (previously it aborted the whole pass). Partial cluster progress is now committed
rather than discarded on failure.

New `cognition_config` tunables: `maxMergesPerPass` (default 20; cap on facts merged across all
skills per pass) and `maxEnrichmentsPerPass` (default 10; cap on `none` facts given an enriched
second look, the rest deferred not retired). `maxClusterSize` is now the per-skill cap. `DreamRun`
records gain `deferred`/`retired`/`quarantined` counts and an `errors` list; `unassignedRemaining`
now means immediately-actionable (over-budget strong) facts.
