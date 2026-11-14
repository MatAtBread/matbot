---
"@matatbread/matbot-cognition": patch
---

Dream-time retires a restatement of a fact already decided without ranking it (`__duplicate__`), ranks one copy of several identical new facts, and moves a fact routed weak `weakVerdictsBeforeBacklog` times (default 4) to a `__backlog__` that passes no longer re-rank, keeping its last verdict. The ranker sends the skill roster as a cacheable system prompt.
