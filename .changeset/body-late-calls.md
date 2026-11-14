---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-function-tools": patch
---

A function body's tool calls run until they finish, like any promise, whether or not the body awaited them; returning stops none of them (#114). To stop a call it no longer needs, a body passes a signal through `toolInContext({ signal })`. The turn's abort still stops them, and a body whose caller stops reading has every later call refused.
