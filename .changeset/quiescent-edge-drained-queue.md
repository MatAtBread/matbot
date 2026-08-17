---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-core': patch
---

The quiescent edge is the drained queue, not the end of a turn.

A deferred machine mutation — the `StorageBackend` swap, the mount table's batched notifications —
landed whenever no *turn* was in flight. But the pump does a great deal of store work outside a turn:
it re-reads the committed document for `followup`, appends markers to it, rewrites it for a retract,
and persists the next queued turn's user message before that turn opens. All of that was quiescent, so
a mutation could land in the middle of it — the turn's write-back going to one backend and the
followup marker appended to it in another, which is precisely the split the deferral exists to
prevent. A two-turn queue reached the "idle" edge six times mid-flight.

`machineBusy(fn)` is the new `/host` primitive: the half of a context switch that is not about
identity. `contextSwitch(principal, fn)` keeps its meaning and signature and is now literally
`machineBusy` + `runAs`. The pump holds the machine once around its whole queue and `runAs`es per
item, each carrying its own submitter — the same boundary accounting already flushes at, for the same
stated reason that the end of a turn is not a moment anything can be totalled or swapped at.

It is a wrapper rather than a `begin`/`end` pair on purpose: the hold is released on every exit,
including a synchronous throw and a rejected promise. A stranded counter would be unrecoverable —
every later flush no-ops forever, and the only symptom is a deferred mutation that never happens.

What an embedder observes is the timing: a `register()` from inside a turn now takes effect when the
session's queue drains rather than at that turn's end, which for back-to-back turns (a `followup`
resubmission, a retract-and-rerun) is later than before. The mount contract already promised only
eventual, ordered delivery and explicitly not timing. Frontend entry points are unchanged: a web
request or telegram message still uses `runAs` and deliberately does not hold the machine, its scope
spanning a long-lived stream.
