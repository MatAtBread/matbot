---
"@matatbread/matbot-function-tools": patch
---

`tool_function`'s description says that `fetch`, `AbortSignal`, `WebSocket`, `console` and the timers are ordinary globals in a body, which no runner here withholds (`types` lists any that are), so an HTTP request inside a body is `fetch` and never a reason to install the `http` tool. The model reached for `http` — installing it if absent — because it had a schema and was visible, while `fetch` was mentioned only in passing. (#99)
