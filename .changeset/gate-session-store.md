---
"@matatbread/matbot-core": patch
---

`gate_action session-store` reports and sets where "for this session" permission answers are kept — `memory` (the default, gone at restart) or `settings` (kept until forgotten) — and `null` reverts to the configured default. Switching to `settings` moves the answers already held in memory there.
