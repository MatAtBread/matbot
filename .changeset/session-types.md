---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-function-tools": patch
---

`SessionTypes`, an open registry keyed by tool name, and `Tool.sessionType(session)`: what a session holds,
as a type, added by `function-tools` for a check made on a session's behalf (`execute`, a session `define`,
its re-`check`, `types`) under the tool's own name. A global function's check sees it empty.
