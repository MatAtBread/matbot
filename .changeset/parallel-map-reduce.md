---
"@matatbread/matbot-parallel-map-reduce": patch
---

New plugin: `parallel_map_reduce` asks one question (`mapPrompt`) of each item of a set (`items`: text, or
`{ attach }` for a file) as concurrent sub-agent turns (`single_turn`, 4 at once unless `concurrency` says otherwise), appends each answer
to the conversation under its item as it finishes, then asks the conversation to combine them
(`reducePrompt`, a queued robo-submit prefixed with the tally). It returns at once; the conversation is the
buffer.
