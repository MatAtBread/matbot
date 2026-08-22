---
'@matatbread/matbot-function-tools': patch
---

The lambda guidance names its own pathological case: wrapping a single tool call.

**The 0.4.8 nudge over-corrected.** Told when a lambda pays — a verbose result you need a fraction of, a
loop, a conditional — the model started wrapping almost every tool call in one, which is worse than the
behaviour the nudge was written to fix: the same result reaches the conversation either way, and a types
call plus an authoring round have been spent on a wrapper that reduces nothing. Both texts stated the
exclusion only as a *cost* ("not the cheaper route for a couple of small calls"), which is easy to
rationalise past, and offered two invitations against it.

So the test is now stated as a single question — **are you REDUCING a result?** — and the exclusion is a
prohibition rather than a price: do not wrap a single tool call whose result you are not reducing; a body
that is one `await tool.x(params)` and a `return` of what came back is strictly worse than the call it
wraps. The tool description gains a `NOT FOR THIS` block saying the same, with a worked anti-example beside
the two positive ones, and the `lambda` action entry now says outright that it is not a wrapper for a
single call.
