# @matatbread/matbot-edit-session

## 0.4.8

### Patch Changes

- b550d6a: `session_edit` gains `summarise`: an LLM hand-off document in place of history, with the originals kept
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

- Updated dependencies [b550d6a]
  - @matatbread/matbot-plugin-api@0.4.8

## 0.4.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.7

## 0.4.6

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
  - @matatbread/matbot-plugin-api@0.4.5

## 0.4.4

### Patch Changes

- cf42a5a: Editing the session a turn is running in is deferred rather than refused, and compaction no longer
  leaves empty messages behind.

  **`session_edit` defers `cut` / `split` / `compact` on the calling turn's own session.** It refused
  them, because the runner holds one in-memory copy of the session document and writes it back
  unconditionally at turn end — an edit landing mid-turn is silently overwritten, and `split` failed
  worst of all, leaving its new session alive beside a truncation that never happened. The edit is now
  queued on a one-shot `onContextQuiesce` flusher and applied at the next quiescent edge, by which point
  the turn's write-back has happened and the edit reads the committed document.

  The three contracts gain a `{ deferred: true, sessionId, message }` arm, because the outcome cannot be
  reported: the edge is by construction unreachable until the calling turn has ended, so awaiting the
  real result from inside that turn would deadlock. A negative `msgIndex` is anchored to an absolute one
  at call time, before the turn's own tail lands and moves what "third from the end" means. There is no
  CAS retry — a conflict means another writer got in, and losing the edit is the honest outcome.

  **`compact_sessions` now compacts the calling session too**, on the same edge, reported under a new
  `deferred` array with no tier and no count (both are decided when it is applied). It previously
  reported that session as `skipped: 'current session'` — declining to compact the one session whose
  history is re-sent every round.

  **Compaction removes a message it empties.** Stripping tool calls, tool results and thinking left
  behind a husk no provider ever saw — the Anthropic converter skips empty content and folds the
  adjacent same-role messages either side — but which a frontend reading the stored array draws as an
  empty bubble. Both sides of a tool exchange are stripped in the same pass, so they disappear together
  and no call is left without its result; shells from earlier compactions are collected too. Positions
  before the cutoff therefore shift, which nothing addresses across a reload: provenance
  (`remember_fact`, `dream_time` enrichment) is by message id, and the one baked index — this plugin's
  cross-session `targetMsg` — is documented best-effort and was already fragile to `cut` and `split`.

  The web frontend narrows `split`'s result before reading `newSessionId`, the deferred arm being
  unreachable there (the tool endpoint carries a stub session).

- @matatbread/matbot-plugin-api@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2

## 0.3.10

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2

## 0.2.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8

## 0.2.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6

## 0.2.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.7

## 0.1.6

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.1
