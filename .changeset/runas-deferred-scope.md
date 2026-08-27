---
"@matatbread/matbot-plugin-api": patch
---

`runAs` no longer drops the principal when `fn` returns deferred work. An unpulled async iterator — the
shape `ToolExecutor.execute()` returns — carried its body outside the scope, so a host wiring its own tool
invocation established the identity for the construction only, and silently ran the work under whatever was
ambient (a boot principal, not an error). The identity is now re-established around each pull, and a native
promise is unwrapped to find an iterator behind an `async () => execute(…)`.
