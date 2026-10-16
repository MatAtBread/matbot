---
"@matatbread/matbot-edit-session": patch
---

`session_edit` accepts the message it pivots on by id as well as by position: every action takes `msgId` (the `id` of a message in the session, as `session_action get` returns them) as an alternative to `msgIndex`, with the same meaning — `cut` drops that message and everything after it, `fork`/`split`/`compact`/`summarise` act on the messages before it. Give one, not both; `summarise` still takes neither to mean the whole session. An id the session does not hold is an error that changes nothing, fork and split included. `msgIndex` is unchanged.
