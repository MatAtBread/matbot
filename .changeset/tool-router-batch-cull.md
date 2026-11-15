---
"@matatbread/matbot-tool-router": patch
---

Searches made together rank as one moment, so a broad search no longer culls the top hit of the search
beside it; fallbacks are marked and ranked after every real match. A tool is pinned as a fallback only if
it could answer a request that names neither it nor what it does; earlier verdicts are judged again once.
