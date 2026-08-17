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

**A flusher may now be asynchronous.** `onContextQuiesce` takes `() => void | Promise<void>`, and
returning a promise makes the edge wait rather than merely start the work; `quiesced()` is the other
half, awaited by an operation that must not overlap deferred work. The pump awaits it before taking
its copy of the session, so an edit deferred out of one turn has landed before the next turn reads it.
Flushers are invoked in registration order and then settle together; the synchronous prefix still runs
inline, so a mutation staged and landed with a bare `flushIfQuiescent()` is in effect before the call
returns.

The edge does not give exclusivity against the rest of the machine, and cannot: once any flusher
awaits, an HTTP endpoint can accept a request and run a tool call inside that window — so serialising
flushers against each other would remove one source of concurrent mutation and leave every other one.
Contention over a service is the service's to resolve — a `Store` answers it with compare-and-swap —
and the sweep's job is to make contention rare. A backend swap is staged, never applied, while a flush is
settling, which narrows one further window: compare-and-swap answers "did this document change?", not
"did the medium change?". That exposure is not new and is not the flushers' — an HTTP tool call has
always been able to straddle a swap the same way — and the fix belongs in a `cas` that checks it is
writing to the backend it read from.

What an embedder observes is the timing: a `register()` from inside a turn now takes effect when the
session's queue drains rather than at that turn's end, which for back-to-back turns (a `followup`
resubmission, a retract-and-rerun) is later than before. The mount contract already promised only
eventual, ordered delivery and explicitly not timing. Frontend entry points are unchanged: a web
request or telegram message still uses `runAs` and deliberately does not hold the machine, its scope
spanning a long-lived stream.
