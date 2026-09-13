---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-core': patch
'@matatbread/matbot-default-gate': patch
'@matatbread/matbot-tool-mcp': patch
---

`PluginSettings.entries()` — a plugin can enumerate its own settings

The facade was `get`/`set`/`delete` with no way to ask what a namespace holds, so a plugin with
per-key state had to keep an index key beside the data. That index is wrong in three ways at once: it
cannot see a key the *installation* configured via `default_settings:` (which is in force and
therefore part of the answer), it drifts when the write and the index-write are interrupted — leaving
state in force but invisible to the plugin's own listing — and it records what was *ever* written
rather than what is set.

`entries()` returns everything in force as one map, layered exactly as `get` is: a stored key wins,
else the install's configured default. It costs exactly one `get`, because a settings namespace **is**
one document — which is also why there is no `keys()`: that plus N × `get` would be N+1 reads of the
document this returns in one.

Adding a method to the interface affects implementations, not consumers; there is one
(`makePluginSettings`, which the browser host reuses) plus the node MCP plugin's prefix-scoping
wrapper, which now enumerates its own half of the shared document.

`matbot-default-gate` drops its `__gates__` index as a result: `remember()` is a single write, and
`gate_action get` lists the answers an installation *shipped* alongside those someone answered at a
prompt — which the index could never see.
