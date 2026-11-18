---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-function-tools": patch
---

A tool that fails inside a `tool_function` body no longer loses everything but its message. The proxy (and `toolResult` / `toolText`) throws an error that keeps the callee's `code`, `failure`, `stdout` and `stderr`, read back with the new `toolErrorDetail(e)`, and `tool_function` reports a failure the body let escape with that stdout, stderr and failure class — redacted like the rest of its output. Its own `code` is left out, being the callee's number. Before, a script that died inside a body reached the model as "Process exited with code 127" with no stderr, and the model, with nothing to change, ran the same body again.

`context.writeSecret` refuses a value under 8 characters, since redaction is by exact match and a short value would blank every occurrence of itself in the call's output; and a stored value containing another stored value is now redacted whole, whichever was stored first.
