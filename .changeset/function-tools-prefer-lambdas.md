---
'@matatbread/matbot-function-tools': patch
---

`tool_function` now argues for itself in the system prompt, and says plainly when to reach for a lambda.

**A model that never considers `tool_function` never reads its description.** Left to itself it pulls a
verbose tool result into the conversation to extract a line of it, and drives a loop a round at a time —
both of which keep every intermediate listing, row and file body for the rest of the session. The advice
therefore goes where it is read before the mistake is made: this plugin registers a
`SystemContextContributor`, and the tool's own description now opens with when to use it rather than what
it is. Constant text, so it is a stable cache prefix rather than something rebuilt per turn, and it
appears only when this plugin is loaded — the tool being optional is exactly why the recommendation
cannot live anywhere else.

Both are framed on the size and shape of the work, not the number of calls: a lambda is for a VERBOSE
result you need a fraction of (a count, a total, an aggregate, two fields) and for LOOPS AND CONDITIONALS
(the same call over n items, read-each-and-decide, retry-until). And it says what it costs — the types
call plus authoring the body is a call or two, so two direct calls with small results are left alone.
"More than one call" would be the wrong rule: reaching for the tool is itself more than one call.
