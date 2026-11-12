---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-function-tools": patch
---

A tool call a function body makes after it has returned, for example from a timer it set, now runs. When the body settles, only the calls it left running are stopped (#114). `makeToolBox` returns `stopInFlight()` for this.
