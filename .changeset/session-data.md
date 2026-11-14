---
"@matatbread/matbot-session-data": patch
---

New plugin: `session_data` keeps intermediate results in a conversation as markers and reads them back by id
(`write`/`read`/`list`/`drop`), at most 65536 bytes of JSON each and readable within the call that wrote it.
A read by a literal id is typed, for code checked on the conversation's behalf, by what the entry holds; a
global function may call it and reads `unknown`.
