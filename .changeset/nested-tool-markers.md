---
"@matatbread/matbot-plugin-api": patch
"@matatbread/matbot-core": patch
---

A marker a tool yields when called from a composed body is kept: `makeToolBox` passes a callee's markers to
its `onEvent`, which `function-tools` yields as its own, where it used to keep only the result (a session
`define` made from a body said "Defined" and did not exist). `single_turn`'s turns with tools hand back the
markers their tools recorded, which it yields before its result, so they are kept in the calling session;
core's record of the run itself (depth, truncation, retraction, hook errors) is not.
