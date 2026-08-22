---
'@matatbread/matbot-edit-session': patch
'@matatbread/matbot-frontend-web': patch
---

`session_edit` gains `summarise`: an LLM hand-off document in place of history, with the originals kept
where only a later summarise can read them.

**`compact` shrinks a session by shape, which is the wrong axis for a long thread.** It strips thinking,
tool calls and tool results and keeps every word either party said — so the discussion behind a decision,
the approaches abandoned, and the search results that were true an hour ago all survive, while what a
successor actually needs (the goal, the decision, the outcome, what is still open) is scattered through
them. `summarise` inverts that: one `singleTurn` on `provider` (default: the turn's own) rewrites
`messages[0..msgIndex)` as a two-part hand-off — a `user` message carrying what was wanted, an
`assistant` message carrying what is known now. Both halves are marked `origin: 'robo'`: matbot wrote
them, so a frontend presents them agent-side while the model reads an ordinary user turn and assistant
reply.

The prompt is where this feature lives or dies, and two things in it are load-bearing. **It keeps
answers.** "Drop the intermediate data a successor can obtain again" sounds right and is catastrophic in a
conversation made of questions and answers, since every answer was derived from a tool result — so the
rule is to drop the BULK that produced an answer (a listing, a search result set, a file body) and never
the answer, which is the durable result of the exchange rather than working material. **And a session need
not have an objective.** A conversation that hopped between unrelated topics is not a failure case: the
list of topics is the goal, and the state is what was established about each. Presuming a single aim is
what makes a model reach for the freshest thing resembling one — which, when the last thing asked was
"compact this session", is the compaction itself. The prompt also says outright to ignore any request to
summarise or tidy the conversation: that is the operation, not the work. Prose is capped far more
generously than tool output for the same reason — an answer truncated mid-sentence is the summary losing
what it exists to carry.

**The replaced messages are not destroyed — they move into a `summarised` marker**, which every provider
converter elides. So they leave the model's context without leaving the record, and a SECOND summarise
expands the marker and summarises the ORIGINAL text rather than summarising a summary, which is the
difference between compacting a session repeatedly and losing a little more of it every time. The marker
is written flat (a summarise expands any it finds in the range it replaces), so the history is always
exactly one hop from the session however often it is run. The document does not shrink on disk as a
result — `cut` remains the way to actually discard.

One consequence is accepted deliberately: because the marker is elided from every submission, repeated
summarising keeps the live conversation small while the summariser's prompt keeps growing — it is handed
everything ever summarised. So "the turn's provider fits the session, or the session would already have
failed" is true of the session and false of this call from the second summarise on. It is left to fail
rather than budgeted, because the failure costs one call and mutates nothing, and the remedy — name a
larger `provider` — is already in the caller's hands. A character budget would be a crude proxy for a
token window, and degrading to summarising the summary would quietly reintroduce the compounding loss the
marker exists to prevent. The tool's description says so, since there is no config tool to say it in.

**The LLM call runs before any mutation**, so a provider failure or a reply that is not the two-part
document leaves the session untouched and says why, rather than replacing real history with something
unparsed. On another session the write CASes against the version the summary was read from — the call is
slow enough for a concurrent write to be real, and summarising over one would discard it silently. On the
calling turn's own session it defers to the quiescent edge like `cut`/`split`/`compact`, with the summary
already written by then. The three replacement messages carry the last replaced message's timestamp, not
the current one: `lastActivityAt` reads the final message's stamp, so a fully-summarised session would
otherwise re-date itself to the top of a recency-sorted list. `summarize` is accepted as the same action.

**`msgIndex` is optional for `summarise` alone, and omitting it means the whole session** — which is what
"summarise this session" asks for, and is now the documented default rather than something a caller has to
compute. In the session the calling turn is running in, "the whole session" ends where THAT TURN began: a
turn's user message and its tool rounds are already on `ctx.session` by the time a tool runs, so an
unclamped "everything" sweeps in "compact this session" plus the assistant's attempts at it — and those are
the freshest thing in the transcript, which is exactly what a hand-off prompt asks about. Measured, not
hypothesised: the first real summarise was called with `msgIndex: -1` and came back reporting the
compaction as the goal and its own completion as the state, having also confabulated the tool call it
thought had done it. An explicitly named index is still honoured as given, `[0, messages.length)` is now a
legal range (the end of the array is "all of it", not out of bounds), and the four positional actions still
require an index — their refusal names `summarise` as the one that may omit it.

**The web UI offers it from the message-divider popup**, beside Compact — the two are siblings, both
rewriting the history before the point you clicked. It passes the provider selected above the composer,
because it has to: that endpoint builds a session-less tool context with no provider on it, so unlike a
call made inside a turn there is nothing for the tool to fall back to. The confirm names the model that
will write the summary and says the originals are kept; the divider line pulses while the call is in
flight, since the popup closes and an LLM-backed action takes seconds where every other action on that
toolbar is instant.
