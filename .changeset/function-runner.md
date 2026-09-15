---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-core": patch
"@matatbread/matbot-function-tools": patch
"@matatbread/matbot-cli": patch
---

Bound model-authored code: an optional `FunctionRunner` service (registered by the CLI over `node:vm`) stops a `tool_function` that does more than 10s of synchronous work without awaiting, instead of freezing the daemon. The limit is `function_timeout_ms` in `matbot.yaml`; `0` registers no runner. `invokeTool` refuses to start a tool on an aborted signal, and `runFunction` stops waiting when its call is aborted.
