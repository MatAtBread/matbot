---
"@matatbread/matbot-core": patch
---

Spend recorded after a turn ends is kept when nobody is watching the session: each entry is queued by
session as it is recorded rather than in the session's runner state, which is dropped once the session
idles unwatched, and is written by the next pump or one started shortly afterwards.
