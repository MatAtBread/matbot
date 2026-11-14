---
"@matatbread/matbot-cognition": patch
---

One dream-time pass at a time across processes, by an expiring lease in the `dream_lease` store; a pass that finds it held is skipped. A weak fact whose anchors (URLs, emails, ids, addresses, dates, versions) all appear in its skill is retired as `__known__`. `dream_time` runs without a calling turn when both its providers are pinned, and a skill with no metadata yet is skipped rather than failing the pass.
