---
"@matatbread/matbot-tool-skill-compiler": patch
---

The typecheck-repair passes carry the specification.

Pass 1 opened with "THE SPECIFICATION … it is authoritative" and handed over the skill, the distilled method and any operator feedback; passes 2..4 saw only the environment block, the broken source and the diagnostics. `singleTurn` is stateless and was called without a `system`, so nothing carried over — the spec was simply absent from every repair, leaving "keep the behaviour identical" pointing at the broken code as its only stand-in.

A repair with no spec to fix *towards* can satisfy the compiler by deleting the behaviour that raised the error: yielding a placeholder where a computed value belongs, dropping the offending field from the result, or rewriting the `ToolContracts` arm to match whatever the implementation happens to produce — all of which typecheck, and the last of which silently rewrites the contract other tools compose against. Over four passes of "fix this" there was also nothing pulling successive attempts back towards the original intent.

The spec is now extracted once per path (`specBlock`) and used twice: in pass 1's prompt, byte-identical to before, and as a standing `system` prompt for every repair pass, alongside a repair-specific discipline — the source is a previous attempt, not a second source of truth; never resolve an error by removing what the spec requires; restore anything an earlier pass dropped. Because it is `system` and identical across passes 2..N it is a stable cacheable prefix rather than context that grows with the attempt count, and the repair prompt is now only what changes: the current source and the latest diagnostics.

Not covered: nothing grades whether the code that finally compiles *meets* the spec, so a pass-1 mis-implementation that typechecks still installs clean. The reasoning against a general "does this meet the spec?" pass — and the structural form it would need instead — is recorded at the repair loop.
