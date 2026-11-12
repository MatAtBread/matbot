---
"@matatbread/matbot-function-runner-node": patch
---

A failure a function body leaves unhandled is contained and logged instead of ending the process. This covers a throw in a timer it scheduled, a rejection nothing awaits, and a late tool call refused because the body had already returned. Unhandled failures from anywhere else end the process as before.
