---
"@matatbread/matbot-tool-router": patch
---

The tool window is configured in the plugin's settings instead of constants: `targetWindow` (default 20),
`cullTrigger` and `cullTarget` (default from `targetWindow`, 100% and 60%), and `eagerFill` (default
false). Lowering `targetWindow` alone shrinks the whole window, which a small model needs.

The new `tool_router_config` tool (`get`/`set`/`clear`) reads and changes them, for an install with no
`default_settings:` to author them in, such as the browser. `set` refuses a value that is not a positive
integer (or a boolean, for `eagerFill`), and a combination that defeats itself once stored values are
included: a `cullTrigger` below `targetWindow`, or a `cullTarget` above `cullTrigger`. Nothing is written
when it refuses. The tool is kept out of `tool_search`'s catalogue line and is never pinned, but a search
finds it.

Settings are read on each presentation and search, so a change applies from the next call. A bad value
that arrives another way falls back to its default, is logged once, and is listed by `get`.
