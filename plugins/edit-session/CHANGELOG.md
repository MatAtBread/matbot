# @matatbread/matbot-edit-session

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
