# Changelog

All notable functional changes are documented here. Purely stylistic or
non-functional changes (CSS, refactoring, code tidying, docs-only merges) are
omitted.

Within each section, changes are grouped: **Breaking changes**, **API gaps
filled**, and **Bug fixes** cover `core` (the contract consumers depend on);
**Optional** covers new or updated plugins, frontends, and apps — more likely to
churn and less likely to affect a consumer who doesn't use them.

## 0.4.4

### Breaking changes

- **The quiescent edge is the drained queue, not the end of a turn.** A deferred machine mutation — the
  `StorageBackend` swap, the mount table's batched notifications — landed whenever no *turn* was in
  flight, and the pump does a great deal of store work outside a turn: it re-reads the committed
  document for `followup`, appends markers to it, rewrites it for a retract, and persists the next
  queued turn's user message before that turn opens. All of it was quiescent, so a backend could be
  swapped in the middle of it: the turn's write-back landing in one backend and the followup marker
  appended to it in another. A two-turn queue reached the "idle" edge six times mid-flight; it now
  reaches it once, after the queue drains — the same boundary accounting already flushes at, for the
  same stated reason that the end of a turn is not a moment anything can be totalled or swapped at.

  The hold is a new `/host` primitive, `machineBusy(fn)` — "hold the machine for this operation" —
  which is the half of a context switch that is not about identity. `contextSwitch(principal, fn)`
  keeps its meaning and its signature, and is now literally `machineBusy` + `runAs`; the pump holds
  once around its whole queue and `runAs`es per item, each item carrying its own submitter. It is a
  wrapper rather than a `begin`/`end` pair on purpose: the hold is released on every exit including a
  synchronous throw and a rejected promise, because a stranded counter is unrecoverable — every later
  flush no-ops forever and the only symptom is a deferred mutation that never happens.

  **A flusher may now be asynchronous** — `onContextQuiesce` takes `() => void | Promise<void>` — and
  returning a promise makes the edge wait rather than merely start the work. `quiesced()` is the other
  half: an operation that must not overlap deferred work awaits it before holding the machine, which
  the pump does, so an edit deferred out of one turn has landed before the next turn takes its copy of
  the session. Without it the deferral only moved the race: the edit began after the turn committed,
  and a submission arriving meanwhile could read the document before the CAS and put the pre-edit
  version back with its own write-back.

  Flushers are invoked in registration order and then settle together, the synchronous prefix still
  running inline — so staging a mutation and landing it with a bare `flushIfQuiescent()` is in effect
  before the call returns, as before. The edge does not give exclusivity against the rest of the
  machine and could not: once any flusher awaits, an HTTP endpoint can accept a request and run a tool
  call to completion inside that window, so serialising flushers against each other would remove one
  source of concurrent mutation while leaving every other in place, at the price of every flusher
  waiting on the slowest. Contention over a service is the service's to resolve — a `Store` answers it
  with compare-and-swap — and the sweep's job is to make contention rare, not to pretend the machine
  stops. A backend swap is staged, never applied, while a flush is
  settling, which narrows one further window — compare-and-swap answers "did this document change?",
  not "did the medium change?", so a read from one backend and a write to another compares a version
  against a backend that never issued it. That exposure is not new and is not the flushers': an HTTP
  tool call has always been able to straddle a swap the same way. The fix belongs where the consequence
  lands, in a `cas` that checks it is writing to the backend it read from — noted here as a known gap.

  Listed as breaking because the *timing* an embedder or plugin observes changes: a `register()` from
  inside a turn now takes effect when the session's queue drains rather than at that turn's end, which
  for a session running back-to-back turns (a `followup` resubmission, a retract-and-rerun) is later
  than before. The mount contract already promised only eventual, ordered delivery and explicitly not
  timing, so nothing that honoured it needs changing. Frontend entry points are unaffected: a web
  request or telegram message still uses `runAs` and deliberately does not hold the machine, its scope
  spanning a long-lived stream.


- **`workspace_action` speaks of names, not paths.** `path` becomes `name` on read, write and
  delete and in every result; `list` takes `prefix`; `recursive` is gone. A workspace file is an entry
  in a `FileStore` namespace, addressed by one flat string — the `/` in `charts/data.csv` is an
  ordinary character, not a level, and there is no directory anywhere in the medium to create, change
  into or walk. Calling the parameter `path` invited the whole hierarchical model in, and the calls it
  produced failed in the ways that model predicts and this one cannot honour: `list { path: "." }`
  matched nothing (the executor appended a `/`, and no name begins `./`), and `write { path: "./notes.md" }`
  created a *second* file distinct from `notes.md`, addressable only by repeating the `./`, because
  names are stored verbatim. Normalisation now drops `.` segments everywhere, so those two converge,
  and a `..` in a `list` prefix is an error rather than a silently empty listing, as it already was
  elsewhere.

  **`recursive` is removed, and `list` now always returns every matching file.** It never recursed:
  the executor enumerates the whole namespace on every call and `recursive: false` only discarded names
  with a further `/` in them, so the default suppressed results already in hand and bought nothing —
  a depth default borrowed from filesystems, where a deep walk is expensive, applied to a store where
  both branches cost the same. Its failure was quieter than the `path` one, too: `list {}` returned a
  short list that reads exactly like a complete answer to "what is in my workspace". Narrowing is
  `prefix`'s job; if listing size ever needs a control, that control is a limit, not a depth.

  Listed here rather than under **Optional** with the plugin's other changes: the tool ships by default
  and every parameter of it changed at once, so a stored `function-tools` lambda, compiled skill or
  trigger `invoke` naming the old shape breaks — and breaks *quietly*, since `inputSchema` is loose by
  design and an unknown key is ignored rather than rejected. A stale `list` call now lists the whole
  workspace instead of erroring; a stale `read` or `write` fails on the missing `name`.

### Bug fixes

- **A store write can no longer cross a `StorageBackend` swap.** Exactly one backend is active and
  nothing is migrated between them, so a caller that read a document before a swap and wrote it after
  was addressing two media with one read-modify-write — and nothing could see it: compare-and-swap asks
  "did this document change?", which the incoming backend answers about a document it never issued,
  usually "there is nothing here". An unconditional `set` then recreated the previous backend's
  document inside its replacement, and a session had silently migrated. Reachable wherever a read and a
  write straddle the swap: an HTTP tool call has always been able to, and deferred quiescent-edge work
  now can too.

  `mediumGuard` (`@matatbread/matbot-core/storage-base`, wrapped around each store proxy by both hosts)
  puts the check where the consequence lands rather than asking every caller to know something only
  storage knows. The version is the only token tying a read to its write, so it carries the medium:
  stamped on the way out, checked and stripped on the way in — stripped because most write-backs reuse
  the version they read (`store.set(id, { ...doc, title })`), and a persisted stamp would be stamped
  again on the next read. An unstamped version is always accepted, being a document the caller minted
  rather than read. A stale `cas` returns `{ ok: false }` — the loss every caller already handles, with
  the medium in the role of the other writer — and a stale `set` throws, having no other channel.

### Optional

#### edit-session

- **`session_edit` defers an edit of the running turn's own session instead of refusing it.** `cut`,
  `split` and `compact` on `ctx.session.id` used to return an error, because the runner holds one
  in-memory copy of the document and writes it back unconditionally at turn end — an edit landing
  mid-turn is silently overwritten. The edit is now queued on a one-shot `onContextQuiesce` flusher and
  applied at the next quiescent edge, by which point the turn's write-back has happened and the edit
  reads the committed document. The result reports `{ deferred: true, sessionId, message }` rather than
  the usual counts: the edge is by construction unreachable until the calling turn has ended, so
  awaiting the real outcome from inside that turn would deadlock. A negative `msgIndex` is resolved to
  an absolute one at call time, before the turn's own tail lands. Deferred edits are serialised against
  each other; a failure is logged, having no caller left to tell. `fork` is unaffected — it only writes
  a new document — and every edit of *another* session stays immediate.

- **`compact_sessions` compacts the session it was called from, deferred, instead of skipping it.** It
  reported the calling session as `skipped: 'current session'` — declining to compact the one session
  whose history is re-sent on every round, for the same reason `session_edit` used to refuse it. It now
  queues that one on the same quiescent edge and reports it under a new `deferred` array, which carries
  no tier and no count: both are decided when it is applied. The whole per-session policy (tier
  decision included) moved behind one re-read so the deferred pass decides against the document the
  turn actually committed, not the one the scan saw — and because the tiers address messages from the
  end (`-1`, `-10`), "keep the last 10" still means the last 10 once the turn's own tail has landed.

  The guard remains `ctx.session.id`, which protects the *calling* turn and no other: invoked over
  HTTP, where the tool context carries a stub session, nothing matches and a session another turn is
  running in is compacted inline — where that turn's unconditional write-back at turn end silently
  reverts it. That is the quiescent edge's granularity, addressed separately.

- **Compaction removes a message it empties, instead of leaving an empty shell.** Both `session_edit`'s
  `compact` action and `compact_sessions` dropped every block of a message that held only tool calls,
  tool results or thinking, and kept the message itself — a stored husk no provider ever saw (the
  Anthropic converter skips empty content and folds the adjacent same-role messages either side) but
  which a frontend reading the stored array draws as an empty bubble. Both sides of a tool exchange are
  stripped in the same pass, so they disappear together and no call is left without its result. Shells
  left by earlier compactions are collected too, so an already-compacted session is cleaned by its next
  compaction. Message positions before the cutoff therefore shift, which nothing addresses across a
  reload — provenance (`remember_fact`, `dream_time` enrichment) is by message id, and the one index
  that is baked, this plugin's cross-session `targetMsg`, is documented best-effort and was already
  fragile to `cut` and `split`.

#### frontend-web

- **The browser UI is type-checked against the live tool contracts, and `pnpm web-build` fails if it
  isn't clean.** The UI is plain browser JS served verbatim, so nothing connected its `callTool` calls to
  the `ToolContracts` the tools declare — `workspace_action`'s rename of `path` to `name` blanked the
  file panel, and the way it failed is the point: reading a field that no longer exists yields
  `undefined`, which renders as an empty row rather than an error, so it looked like "no files" and not
  like a bug, in the one part of the system nobody compiles.

  `static/matbot-ui.ts` imports the packages whose augmentations declare the tools the UI calls and
  derives the transport's `callTool` signature from them, so params are checked against the tool's arms
  and the result narrows to the arm they match. Consumers annotate their params from the same source
  (`ToolResult<'workspace_action', { action: 'list' }>`) rather than restating a shape. `pnpm web-build`
  runs the check before baking `app.js` into `matbot.html`, since a bundle is the last place a broken
  UI file can still be caught.

  The gate is about DATA, not the DOM: element narrowing is deliberately widened away, because the ~80
  casts it would take are noise against the bug class worth catching, and a gate that expensive gets
  turned off. Its reach ends where a value enters an unannotated function, so a new panel needs its
  consumer annotated to be covered — and it cannot see field names inside strings (a `[data-name]`
  selector, a template).

  Three real defects fell out of turning it on: `workspace_action` `delete` and upload still passed
  `path`; `share`/`owner` was read as `.owners` (bulk) or `.owner` (single) without narrowing, though
  the contract returns a union of the two and only the runtime id decides which; and the in-process
  browser transport passed `ownerPrincipal` to `createSession`, which copies three fields and has never
  been one of them, so session ownership there was silently discarded rather than recorded.

#### function-tools

- **`tool_function { action: 'check' }` re-type-checks functions you already defined.** A defined
  function is type-checked once, at `define`, against the tool types as they stood then — and on every
  later reload it is only *compiled*, never re-checked. So a tool that changes its contract silently
  invalidates every stored function composing it: the function keeps registering, keeps being offered
  to the model, and fails when it is next called. `check` closes that window by re-running the same
  snippet through the same `ToolTypeIndex.check` that `define` and `lambda` use — no third notion of
  what "checks out" means — and reports a row per function. Pass `name` for one, omit it to sweep all
  of them. Nothing is run, registered or persisted.

#### tool-store

- **A query grammar key passed beside `action` is no longer silently discarded.**
  `{ "action": "query", "limit": 0 }` — the grammar flattened one level up instead of nested under the
  `query` parameter — reached `store.query(input.query ?? {})` as `{}`: the limit was dropped, the
  query degraded to match-everything, and the count form came back as every document in the store plus
  a `total`, which reads exactly like a working answer. It is the silent miss `validateQuery` rejects
  unknown top-level keys to prevent, reappearing where `validateQuery` cannot see it, because the
  misplaced key never becomes part of a `StoreQuery` at all.

  The cause was the tool's own description: it documented the `StoreQuery` *type* but never the *call
  envelope*, so the nesting had to be inferred, and the count form appeared as the fragment "pass
  `limit: 0`" — which reads as an instruction to pass it at the top level. The description now leads
  with the shape of the call and gives the count form complete. Misplaced keys are also rejected with
  an error naming them and the correct call, rather than answered.

#### storage-sqlite

- **`StoreQuery` is compiled to SQL rather than interpreted.** The grammar is specified as a
  translation target — a closed AST meant to become a `WHERE` clause, an Elasticsearch `bool`, a
  Mongo `find` — but every backend in the repo delegated to the in-memory reference evaluator, so the
  claim rested on the shape of the AST and nothing else. The SQLite backend now compiles the filter
  to `WHERE`, the sort to `ORDER BY`, and the page to `LIMIT`/`OFFSET`, with `limit: 0` becoming
  `SELECT COUNT(*)`. A filtered query no longer reads, parses and sorts the whole namespace to answer,
  and a count materialises nothing at all.

  Documents are JSON text, so a field is `json_extract(doc, <path>)` and its type
  `json_type(doc, <path>)`. That pair carries the whole translation: `json_type` returns NULL for an
  absent path and `'null'` for a stored JSON null — precisely the grammar's single "missing" state —
  and it separates `'true'`/`'false'` from `'integer'`, without which type-strictness could not be
  expressed at all, since a value accessor erases a JSON boolean to the same 0/1 a number produces.
  Field paths are **bound**, never interpolated, so the compiler has no injection surface.

  What the exercise actually establishes is where a native query language disagrees with the grammar
  by default — four points, each of which returns plausible rows instead of failing, and each now a
  named guard: SQL's three-valued logic (`NOT NULL` is NULL, so a row *missing* the field is dropped
  from a negated predicate the grammar says it matches); boolean/number erasure, including inside
  `arrayContains`; missing-value ordering (the grammar's missing-last is a property of the value, so
  it reverses to missing-*first* under `desc`, where SQL's NULL ordering is a property of the
  direction); and the `id` tiebreaker that makes the order total enough for a cursor to point at a
  stable boundary.

  Equivalence is enforced rather than asserted: one conformance corpus of ~70 queries runs through
  both the pushdown and the in-memory reference and must return the same documents in the same order,
  with cursor paging a disjoint cover and identical located `StoreQueryError`s for invalid input. The
  corpus is built around the four traps — documents holding a number where another holds a boolean, a
  JSON null beside an absent field, keys containing `.` and `"`, and ties on every sorted field
  inserted out of id order so a missing tiebreaker cannot pass by coincidence.

  One divergence remains, for a field holding **mixed types across documents** only: SQLite orders
  every number before every string, where the reference stringifies and compares `"10" < "9"`. Within
  a type — a sort on a real field — the two agree exactly.

## 0.4.3

### Breaking changes

- **`Usage.reported` retains what the endpoint actually said; `Usage.costUsd` is deleted.** Adapters now
  pass their `usage` object through verbatim alongside the normalised counters, and guard on **presence
  rather than truthiness** — an endpoint reporting `cache_read_input_tokens: 0` is saying there was no
  cache activity, which is not the same fact as not reporting it at all, and all three adapters
  collapsed the two. `addUsage` sums `reported` numerics key-wise (within one provider only, since
  `prompt_tokens` includes cache hits where `input_tokens` does not) and leaves non-numeric values —
  `service_tier`, latency objects — alone.

  This is what makes the existing normalisation non-destructive rather than replacing it: the adapter is
  the right party to map its own protocol, and it stays so. openai-compat still reports `inputTokens`
  net of the cache hit so a mixed-provider turn can be totalled — but `prompt_tokens` now rides
  alongside, so the subtraction can be checked, reversed, or reconciled against a vendor's dashboard,
  and google's `thoughtsTokenCount` survives being folded into `outputTokens`.

  `costUsd` had no producer and never has: a rate table cannot be keyed on counters that have discarded
  the tier, the modality and the reasoning split. With the raw retained, a consumer computes cost from
  `reported` and holds the answer itself, so the slot has no consumer either. Removed rather than left
  as dead surface (the CLI and web footers stop rendering it).

- **The usage carrier carries a `UsageScope`, not a bare sink, and scopes nest.** `UsageCarrier.run`/
  `tryCurrent` now deal in `{ entries, site?, parent? }`, and `withUsageScope(fn)` hands the scope to
  `fn` so a caller can read what accrued. A scope opened inside another rolls its entries up into the
  parent when it settles (including on rejection — the tokens were spent either way), so a sub-turn can
  be asked what it alone cost without its spend disappearing from the turn containing it. Previously
  `withUsageScope` established a fresh, empty sink and *shadowed* any enclosing one; that was invisible
  only because nothing ever opened a second. Hosts implementing a carrier need the type change only;
  `createSerialUsageCarrier` and the CLI's ALS carrier are updated.

- **Accounting moved off the message that produced it and onto the turn head.** `Message.usage` is
  replaced by `Message.activity: TurnEntry[]`, and `tool-result` blocks no longer carry `usage` at all —
  everything a turn caused is an entry anchored on that turn's user message, self-describing via its
  `site` and causal `traceId`. `createMessage` no longer takes `usage`. Reading is unaffected for anyone
  using `usageByProvider`, which tolerates the old shapes; a consumer reaching into `m.usage` or
  `tool-result.usage` directly should use `turnActivity(messages)` or `usageEntries(messages)`.

  The move is what makes a retried turn account correctly: a retract-and-rerun pops the assistant and
  tool messages into a retraction marker's payload, where no reduction over `session.messages` will ever
  find them, so a retry silently under-reported by the attempt it discarded. The turn head is the one
  message the pop keeps. Locality is not lost — `site` already names the round or tool call.

- **`WatchVisibility.visible` takes a `VisibilityQuery` and is consulted for every notification kind.** The
  predicate could not see the `kind` it was deciding about, so a consumer could not express a per-kind
  delivery policy — routing a partitioned namespace and addressing a fact to a recipient are different
  policies over the same stream, and only an implementation knows which of its kinds wants which. It could
  not see `kind` because the caller had already gated on it: `frontend-web`'s firehose consulted the
  predicate only for an `ItemChange` carrying a principal, so every plugin-defined kind was fanned out to
  every connection with no hook capable of stopping it. Harmless on the in-process bus (one process, one
  user); wrong the moment a distributed `Notifier` bridges an addressed fact in from another instance —
  which these docs explicitly invite. The gate is gone and the judgement moved behind the interface: the
  frontend hands over everything it knows and takes no position on policy.

  `visible(q)` where `q` is `{ viewer, kind, namespace?, id?, origin? }` — an object rather than a fifth
  positional because `kind`/`namespace`/`id` are three adjacent strings around two `Principal`s.
  `namespace`/`id` are optional because a kind may address no item; `origin` was the 4th parameter. An
  implementation must **fail open** on kinds it has no policy for, since it is now asked about all of them.

  No behaviour change: the profiles backend's one policy is partition routing, meaningful only for an
  item-addressed change with an owner, so it returns `true` when `namespace`/`id`/`origin` is absent —
  exactly what the caller's kind gate used to do. The filtered set and every answer are identical.

### API gaps filled

- **`limit: 0` is the count form of a store query.** The filter runs, `QueryResult.total` answers, and no
  document is materialised or cursor issued — so "how many sessions mention invoices?" no longer means
  fetching every one of them and measuring the array, which was the only way to ask and cost the model
  the whole result to read a single number. It is a page size of zero rather than a new `count` action or
  a new grammar key because that is already what the word means, in the AST and in a backend's native
  query alike: fetch no rows, report how many there were. One consequence is that every store-backed
  `query` action gains it at once, including tools that do not exist yet, and it composes with `where`
  rather than restating it. Every backend delegates paging to `executeQuery`, so all of them (filesystem,
  sqlite, google-drive, IndexedDB, the caching decorator, the profiles delegator) answer it from the one
  implementation; a pushdown backend compiles it to `SELECT COUNT(*)`.

- **Every tool call is timed, and the number is kept.** The runner measured a tool's duration, handed it
  to the `toolresult` hook and then discarded it, so a consumer had to re-derive it — less accurately —
  from event arrival times. It is now persisted as a `{ kind: 'span' }` entry and carried live on
  `tool:end`. A span is its own arm rather than a field on an accounting record because most tool calls
  spend no tokens at all (`bash`, `http`, `workspace`): hanging duration off a `UsageRecord` would
  capture it precisely for the tools that happen to call an LLM and lose it for every other one.

  Provider calls carry their own bracket too (`startedAt` / `durationMs` on the call entry) — matbot's
  scope around the call, distinct from any server-side latency an endpoint reports, which arrives in
  `usage.reported` like any other provider-named field.

- **`turnActivity(messages)` / `usageEntries(messages)`** — everything a set of messages records about
  what happened, in message order, with no correlation to do. Filter by `traceId` for a turn, by `site`
  for a tool call, or pass a whole session for its total; `usageEntries` is the calls without the spans,
  and `usageByProvider` is a fold over that. One fact set answers "what did this tool cost", "what did
  this user cost" and "how long did that take".

- **`UsageRecord.traceId` names the turn that caused a call**, which is not the same question as where
  the record ends up. A completion can be recorded after its turn commits (a detached trigger
  classifier, a `followup` hook), and a retract moves messages underneath it. Carrying the cause makes
  grouping by turn a query rather than an inference from adjacency.

- **`UsageRecord.site` records where a completion happened** — `{ kind: 'round' }`, `{ kind: 'tool' }`
  or `{ kind: 'hook' }`. This is the one accounting fact no adapter and no plugin can recover after the
  fact, and it is what makes per-tool, per-user and per-task cost derivable by a plugin from a single
  log without core knowing any of those groupings. Stamped by `recordUsage` from the site in force,
  established by the runner around its own round and each tool executor, and by `HookRegistry` around
  each handler (which already knew the channel and owning plugin). See `docs/ACCOUNTING-RATIONALE.md`.

- **`FilePartition`** — a new optional `MatbotServices` member, registered by a backend that partitions the
  file area (the profiles backend) and consumed by `frontend-web`:

  ```ts
  interface FilePartition {
    current(): string | undefined;                              // the current file area, as an opaque token
    enter<T>(token: string, fn: () => Promise<T>): Promise<T>;  // its inverse
  }
  ```

  A file's address now comes from the router that placed the bytes rather than from a guess at the identity
  in force, and the two halves are one round trip: `GET /files/~<token>/…` resolves through `enter` instead
  of re-entering the token as a principal, which was the same guess one layer up. Base answers `undefined`,
  so an unpartitioned deployment's URLs are byte-identical to before.

### Bug fixes

- **A completion run from a hook is no longer credited to whichever tool happened to be running.** The
  runner attributed a tool's spend by slicing the turn's usage sink by index — mark the length before
  the call, take everything appended after it — so any completion that merely *resolved* during a tool
  call was booked against it. The triggers classifier does exactly that: it is kicked off detached
  inside a `screen` hook and settles at an arbitrary later moment, so whose spend it became was decided
  by a race. Attribution is now by the producer's own declared `site`, which the ambient carrier
  captures where the work *starts*, so the race is unrepresentable rather than merely unlikely.

- **Spend that was previously invisible now appears in the totals**, so figures will rise for anyone
  running triggers or cognition. A `followup` hook ran outside any usage scope, making the triggers
  agent-phase classifier free of charge on every completed turn; a round discarded by an in-situ restart
  dropped its tally with the response, though the tokens were billed; and a retried turn lost the
  attempt it discarded. These were under-reports, not a new cost.

- **Accounting is flushed when the queue drains, not at a turn boundary.** "The end of a turn" is not a
  well-defined moment to total anything at — steers terminate and resume, a retract re-enqueues the turn
  it just popped, followup enqueues resubmissions, and a detached classifier settles whenever it
  settles. A completion still in flight at one idle lands on the next, attributed by its own `traceId`.
  Capture remains best-effort: state is disposed once a session is quiet and unsubscribed, and anything
  still pending then is lost.

- **A retract-and-rerun no longer loses its cost.** A redo re-runs an existing user turn under a FRESH
  `traceId` and introduces no user message of its own, so the redo's entries had no turn head to anchor on
  and the flush dropped them outright — the exact under-report that anchoring on the turn head was
  introduced to prevent, reappearing one level up. A `TurnEntry` now carries `rootTraceId` and anchors on
  the root's head when it has none of its own, which is the honest home anyway: a retry's cost belongs to
  the turn being retried. Found by inspecting a live session — one turn held five entries and no assistant
  message while its answer sat under another trace with none.

- **A zero-length page no longer issues a cursor that pages forever.** `executeQuery` emitted one
  whenever unread documents remained, including at `limit: 0`, where the next page starts at the same
  offset and returns the same empty slice — a caller following the cursor never advanced and never
  finished.

### Optional

- **sessions** — `session_action query` answers `{ total }` for `limit: 0`. It is the one query here that
  cannot early-exit: the text columns it filters on are synthesized per session, so an exact count reads
  every one of them, where a bounded page stops as soon as it is full. That is the expensive query on
  this tool, deliberately — the scan is bounded by what is already on disk, while the array it replaces
  is not bounded by anything the model can afford to read.

- **tool-store** — the generated `<namespace>_action` tools document the count form in their `query`
  grammar; they already forwarded `total`.

- **frontend/web:** turn footers show a turn's spend, and stopped twitching to do it. Three defects, all
  from the same mismatch — accounting is final when the pump's queue drains, which is later than the `done`
  that draws the footer. A live turn showed a bare timestamp where a reload of the same turn showed the
  tokens (the refresh skipped any turn that already had a footer, which is exactly the turn needing the
  rebuild); the numbers then arriving swapped a bare `div` for a `details`, so the timestamp changed
  container and gained a disclosure arrow a second after the turn finished; and footers drawn per `traceId`
  put two under a retried turn — one with no answer left and an empty one under the answer — since a retry
  is one VISIBLE turn spanning two traces.

  The footer is now built once in its final shape and filled in place (an open breakdown survives), the
  refresh only ever REPLACES an existing footer so an in-flight turn is left alone, and footers are drawn
  per visible turn: a user message and everything up to the next one, across every trace in that span. The
  refresh is ordered by a sequence token rather than debounced — two reads in flight can settle out of
  order and paint an older session over a newer one, which a delay makes rarer rather than absent.

- **triggers + cognition:** an interrupted trigger is recorded as interrupted, not failed. A trigger's tool
  runs outside the runner's tool loop, so it never got the `INTERRUPTED_TOOL_RESULT` reframing: a mid-turn
  steer aborted the signal and the raw abort reason landed in a durable marker as "remember_fact extraction
  failed: steer", which reads as a real fault in a trace the user keeps. `dispatchTrigger` now records
  `interrupted: true` and suppresses the warning, and `remember_fact` returns silently when its own
  extraction round-trip is cut off.

- **frontend/web + storage/profiles:** `url_for_resource` no longer stamps a partition segment onto files
  that live in the shared base area. It minted the `~<id>` prefix from the identity in force, gated on the
  presence of the `profile_action` tool — i.e. on "profiles are loaded", not on "these bytes went somewhere
  addressable". A principal with no profile routes to the base area, so an ordinary file came back as
  `/files/~matt/workspace/report.md`: a link that reads as partitioned, leaks the principal id into a URL
  whose whole purpose is to be shared, and 404s the moment a profile of that name is created. The inference
  was unsound in the other direction too — a principal may hold several profiles, and a profile may alias
  its files onto another's area, so the identity does not name the area at all. The address now comes from
  the backend that placed the bytes, through the new `FilePartition` member above.

- **cognition:** `remember_fact`'s first trigger condition no longer treats specificity as durability. It
  matched on "any specific name, number, date, location, relationship, or domain detail", which fires on
  every sensor reading by construction — a battery voltage is the most specific thing in a session. Those
  landed in `remembered_facts`, were merged into skills as if permanent, and then contradicted the next
  reading of the same quantity (3990 vs 4023 mV, stuck vs un-stuck) — never a disagreement about the
  world, just two timestamps of a changing one. The condition now requires the detail to still be true
  tomorrow and excludes current status explicitly. Seeded with `importIfAbsent`, so it reaches new
  installs only; an existing trigger must be updated in place.

- **cognition:** dream-time merges stopped failing on legitimate deduplication. The merger prompt told the
  model to fold a near-duplicate into the existing passage *and* that "the output's length must be >= the
  input's" — two incompatible orders — and a `content.length < input.length - 20` guard then rejected the
  merge when it obeyed the first, quarantining the fact permanently. Observed production failures were all
  in-place dedup, shrinking a 15.5k skill by 34-274 chars.

  The length instruction is gone (a stated length floor invites padding, which is exactly what a size check
  cannot see), and the guard is now a shrink allowance of `max(100 chars, 3%)` — clearing observed dedup by
  several multiples while still catching the loss of a subsection, with the floor because skills run small
  enough that a bare ratio is tighter than whitespace jitter. A heading-presence check sits alongside it,
  catching the trailing section dropped and made up for elsewhere. Both are tripwires for gross loss, not
  proof of integrity. A structural trip now re-rolls once before quarantining: the same merge usually passes
  on a second sample, and quarantine is terminal.

- **tool-types:** the generated dts declares the **live tool registry**, not every plugin on disk. The scan
  roots at each loaded plugin's `resolvedUrl` and then unions a glob of the monorepo `plugins/` tree onto it
  (to catch host-constructed builtins like `plugin` and `provider`, which have no `resolvedUrl`), and every
  `ToolContracts` key on the merged symbol was emitted — so the dts declared tools from plugins nobody had
  loaded. In this repo that was six of them (`telegram_send`, `telegram_provider`, `telegram_open_door`,
  `profile_action`, `share`, `bash_config`), fully typed and indistinguishable from the real ones.

  They reached the model through `tool_function { action: 'types' }` and every skills_compiler codegen
  prompt — which asserts "a tool not declared here does not exist" — and `ToolTypeIndex.check()` graded the
  generated code against the same text. `await tool.telegram_send({ text })` therefore typechecked clean and
  threw `Tool "telegram_send" is not registered` at runtime: the failure the check gate exists to prevent,
  and one the repair loop cannot repair, because the code is correct against the types it was shown.

  `buildMatbotToolsDts` now takes the live tool names and emits only those keys (the wire contracts and the
  clash census are filtered with it); `ToolTypeIndex` and `skills_compiler` pass `tools.list()`. A scanned
  root may supply a tool's *contract*; only the registry says a tool *exists*. The glob is unchanged, and
  host-constructed builtins keep their scanned types. Omitting the argument keeps the whole-tree behaviour
  the clash-census test wants. Node now behaves as the browser `ToolTypeIndex` already did. The per-turn
  wire descriptions are unaffected — they were always keyed by the live registry.

  What this does *not* fix: two roots declaring the same **live** name (`bash`, by `plugins/bash` and
  `plugins/docker-bash`) still merge by Program file order, so an unloaded plugin's declaration can win and
  describe the loaded tool. That is what `conflicts` reports; it is silent today only because the two are
  identical.

- **skills_compiler:** the typecheck-repair passes now carry the **specification**. Pass 1 opened with "THE
  SPECIFICATION … it is authoritative" and handed over the skill, the distilled method and any operator
  feedback; passes 2..4 saw only the environment block, the broken source and the diagnostics. `singleTurn`
  is stateless and was called without a `system`, so nothing carried over — the spec was simply absent from
  every repair, leaving "keep the behaviour identical" pointing at the broken code as its only stand-in.

  A repair with no spec to fix *towards* can satisfy the compiler by deleting the behaviour that raised the
  error: yielding a placeholder where a computed value belongs, dropping the offending field from the result,
  or rewriting the `ToolContracts` arm to match whatever the implementation happens to produce — all of which
  typecheck, and the last of which silently rewrites the contract other tools compose against. Over four
  passes of "fix this" there was also nothing pulling successive attempts back towards the original intent.

  The spec is now extracted once per path (`specBlock`) and used twice: in pass 1's prompt, byte-identical to
  before, and as a standing `system` prompt for every repair pass, alongside a repair-specific discipline —
  the source is a previous attempt, not a second source of truth; never resolve an error by removing what the
  spec requires; restore anything an earlier pass dropped. Because it is `system` and identical across passes
  2..N it is a stable cacheable prefix rather than context that grows with the attempt count, and the repair
  prompt is now only what changes: the current source and the latest diagnostics.

  Not covered: nothing grades whether the code that finally compiles *meets* the spec, so a pass-1
  mis-implementation that typechecks still installs clean. The reasoning against a general "does this meet
  the spec?" pass — and the structural form it would need instead — is recorded at the repair loop.

## 0.4.2

### Breaking changes

- **The `plugin` and `provider` tools' contracts are now named, shared types in `plugin-api`, and the
  browser implementations adopt node's field names.** Both tools have a node and a browser
  implementation, and each declared its own `ToolContracts` arm. A registry key is registered by
  declaration *merging*, so two declarations of one key are only legal while they are identical — these
  were not, which made every program containing both a `TS2717`. `buildMatbotToolsDts` never read the
  Program's diagnostics, so the error was invisible: one declaration won on file order and its shape was
  emitted as the contract. In any tree containing `plugins/` — this repo, or an embedder vendoring it —
  the **browser** shapes won, and a node deployment's generated code was typechecked against them. The
  check loop therefore *rejected* `providers[].hasCredentials`, which node returns, and *accepted*
  `providers[].hasKey`, which is `undefined` at runtime.

  Both tools now declare `PluginToolContract` / `ProviderToolContract` from `plugin-api`, so there is one
  declaration and it cannot drift. Renamed in the **browser** tool to match node and `matbot.yaml`:
  `provider list` → `hasCredentials` (was `hasKey`), `provider add` → `module` (was `adapter`); its
  `parameters` is `ModelParameters` rather than `Record<string, unknown>`. `ProviderRow` is now
  `ProviderSummary`. Where the two runtimes genuinely differ the shared shape carries the superset and the
  divergent member is optional (`DiscoveredPlugin.source`, `ProviderListResult.adapters`); each
  implementation's `inputSchema` is unchanged and still the enforcement point.

- **`FailedPlugin` moved from `core` to `plugin-api`.** It is part of `plugin list`'s result, so the
  contract has to be declarable from a package the tools can reach. Still re-exported from `core`.

### API gaps filled

- **Builtin tool result shapes are named, exported interfaces, so they can be augmented.** They were
  inline object literals, which closed the one extension point the rest of the API leans on: a host that
  overrode a builtin tool and returned a superset could not say so — declaring its own arm is a merge
  error, declaring nothing inherits a shape it does not return. `LoadedPluginSummary`, `DiscoveredPlugin`,
  `PluginListResult`, `ToolSummary`, `ProviderSummary`, `AvailableProvider` and friends now take a
  `declare module` augmentation like any other open registry, and it flows through to `toolResult`, the
  `tool` proxy and the wire description. An undeclared field is still rejected.

### Bug fixes

- **`buildMatbotToolsDts` reports duplicate registry declarations instead of silently picking a winner.**
  Detected from the merged symbol's declaration list, which also names which declaration won and
  distinguishes a real clash from the legal identical re-declaration TypeScript never complains about.
- **The dts scan roots any file that augments `plugin-api`, not only ones naming `ToolContracts` /
  `MatbotServices`.** A file adding a field to a named result shape changes what a contract means without
  mentioning either interface, so it was left unrooted and its field invisible to generators.
- **Plugin-side augmentations of `plugin-api` interfaces are re-emitted into the generated dts.** The dts
  references plugin-api types by name, so an augmentation lived in a file the generated compilation never
  saw and the field vanished exactly where it was meant to be used.
- **Named shapes are expanded in the wire description.** A tool description ships no declarations, so
  `result: PluginListResult` would have told the model nothing. Expanded to the depth an inline literal
  used to render, which also gives structure to tools that already referenced names (`Principal`,
  `Trigger`, `StoreDef`, `DreamRun`).
- **`plugin list` declares `resolvedUrl`**, which its node executor already returned. Conditional spreads
  bypass excess-property checking, so the executor's binding never caught the omission.
- **`--dump-tools` also emits the unfolded wire contract.** Each entry gains `wireContract:
  { params, result }` alongside the description it was already folded into. Additive; existing
  consumers are unaffected.

### Optional

- **web-bundle:** the baked per-tool wire contracts now come from the node compiler at build time rather
  than the regex scanner, so the browser shows the model the same expanded shapes as node. The
  compiler-free scanner still selects *which* tools are baked, and still handles http-fetched plugins at
  runtime; it can now follow a named arm-union (`collectContractAliases`).
- **google-drive:** its `plugin` override augments `LoadedPluginSummary` with `managedBy` instead of
  casting the result to a wider shape.
- **skills_compiler:** imports `SkillManager`'s type from `@matatbread/matbot-skills` (type-only, a
  devDependency) instead of restating a two-method slice of the key. The slice was the last remaining
  duplicate declaration — benign only because the full one happened to win — and being loose at runtime
  never required disagreeing about the type. Consumption is unchanged (`services.SkillManager?.`, still
  degrading when skills isn't loaded) and there is no runtime dependency.
- **function-tools:** a defined function's `inputSchema` now carries the structure its signature declared.
  Its params are projected twice from one parse — verbatim into the `toolContract` (TS to TS, lossless)
  and into the `inputSchema` — and the second projection string-matched the whole annotation, so every
  structural shape collapsed: `'a' | 'b'` → `{}`, `string[]` → `{ type: 'array' }`, `{ sql: string;
  limit?: number }` → a bare `{ type: 'object' }`. Since the `inputSchema` is what the provider is given
  and what `json-validation` enforces, the model was shown a contract in the tool description stronger
  than the schema backing it, and validation had almost nothing to check. Literal unions now yield
  `enum`, arrays `items`, inline object types `properties`/`required`, `Record`/index signatures
  `additionalProperties`, and primitive unions a `type` array.

  The conversion stays deliberately partial: a named or imported type, a union with a structural arm, and
  a tuple's element types still degrade to the permissive form rather than to a guessed constraint. **A
  defined tool now rejects calls it previously accepted** — a missing member of an object parameter, a
  value outside a literal union — which is the point of it. One incidental effect: the Gemini adapter's
  `items` injection (a loose `{ type: 'array' }` is rejected by that API) no longer has to fire for these
  tools.

- **New `pnpm run check:contracts`.** A tool with scannable source authors its parameters twice — as
  `ToolContracts` arms and as an `inputSchema` — with nothing relating the two. They are deliberately
  not identical (the arms are what a composer typechecks against; the schema is the loose gate the
  provider is given and `json-validation` enforces), so neither can be derived from the other without
  deleting what the other carries. The check therefore looks only for *contradictions*: a property in
  one and not the other, a schema `required` no arm accepts, or two different value sets for the same
  property. A schema looser than the contract is never reported — that is the documented multi-action
  design. It reads the `--dump-tools` output, because the two artefacts only meet on the registered
  `Tool` at runtime. Deliberate divergences go in the script's `ACCEPTED` map with a reason.

  It found two divergences in the tree, both now resolved (below), so it currently passes.

- **session_action: `immutable` is no longer part of the `query` contract.** The arm intersected the whole
  of `StoreQuery`, which published `immutable` — a caller-to-store optimisation hint, not a query
  parameter — as a tool input. The executor never read it: it hardcodes `immutable: true`, which is always
  correct there, since every row is copied into a fresh summary and never written back. So the knob could
  be passed by a composer and did nothing. Now `Omit<StoreQuery, 'immutable'>`. No behaviour change.

- **http: `method` accepts `HEAD` and `OPTIONS`.** The schema enumerated five verbs while the executor
  hands `method` straight to `fetch`, and `json-validation` enforces the enum — so two verbs the tool
  fully supports were unreachable by the model. The TypeScript type stays the wider `string` on purpose,
  recorded in the checker's `ACCEPTED`: `json-validation` runs on the `toolcall` hook, which only the
  model-driven turn loop dispatches, so the enum guards what the *model* sends while a composition
  (through `invokeTool`, which bypasses hooks) may legitimately use any verb.

## 0.4.1

### API gaps filled

- **`CompletionRequest.parameters` and `SingleTurnRequest.parameters` are back, and no longer deprecated.**
  0.4.0 removed them on the grounds that a per-call override belongs in the provider profile; that reasoning
  held for *durable* model properties and not for transient ones, and the removal broke a downstream
  consumer. Without them, poking a single call's behaviour — a lower `temperature` to classify, `thinking`
  off for a cheap sub-call, a tighter `maxTokens` on output that gets parsed rather than shown — costs a
  whole new provider profile in global, user-editable config, identical to its sibling but for one field.
  That is a worse trade than the affordance it was meant to prevent.

  Behaviour is exactly as it was before 0.4.0: shallow-merged over the named profile's own `parameters`
  (request wins), resolved by the host before the adapter sees the config, and forwarded verbatim by
  `singleTurn`. **Upgrading 0.3.x → 0.4.1 needs no change here**; only a consumer who already adapted to
  the 0.4.0 removal can now revert that adaptation. The guidance, now documented rather than enforced by
  absence: a profile describes the model, `parameters` describes one call.

## 0.4.0

### Breaking changes

- **Host boot assembly moved off the `plugin-api` root to `@matatbread/matbot-plugin-api/host`.** The root
  exported both what a plugin is written against and what an *embedder* uses to stand a machine up, which
  made carrier installers, swap proxies, the mount table's producer half, `HookRegistry`, `createNotifier`
  and the `Broadcaster` primitive look like stable author-facing API. They are not, and no plugin in this
  repo imports one. Moved: `installPrincipalCarrier`, `enterPrincipal`, `createConstantPrincipalCarrier`,
  `installUsageCarrier`, `createSerialUsageCarrier`, `recordUsage`, `currentUsageSink`, `withUsageScope`,
  `contextSwitch`, `onContextQuiesce`, `flushIfQuiescent`, `unifyServices`, `forwardingProxy`,
  `makeSwappable`, `createMountTable`, `singleTurnRequest`, `HookRegistry`, `createBroadcaster`,
  `subscribable`, `createNotifier`, `scopedNotifier`, and the types `SwapFn`, `MountTable`,
  `PrincipalCarrier`, `UsageCarrier`, `Subscribable`, `Broadcaster`, `Routed`, `RoutedFilter`.

  Three subsystems are split rather than moved whole, keeping their author-facing half at the root:
  `runAs`/`currentPrincipal`/`tryCurrentPrincipal`; the `Notifier` type with `notifyingStore` and the two
  kinds; and `Mounted`/`MountConsumeOptions`/`MountedMachine` (the contract of `services.mounted`).

  **`@matatbread/matbot-core` re-exports the whole of `/host`, so a host that depends on core needs no
  change.** Only a consumer importing boot machinery directly from `plugin-api` does — repoint it at
  `@matatbread/matbot-plugin-api/host` or at core. The boundary is enforced by file layout
  (`host-machine.ts`), not by an export list, so it cannot erode by accident.

- **`ProviderRegistry` is now one interface, not two.** `core/src/types.ts` declared a second, unrelated
  `ProviderRegistry` (`register(adapter)` / `resolve(name)`) alongside its `export type *` of plugin-api —
  and an explicit local export wins over a star re-export, so
  `import type { ProviderRegistry } from '@matatbread/matbot-core'` silently resolved to the adapter
  registry rather than the `ProviderConfig` map that `services.providers` actually is. Nothing imported it,
  so nothing changes at runtime; what goes away is a name that resolved to the wrong shape with no error.

- **`Session.contexts` is removed.** A required `string[]` on every session, written by `createSession`,
  the web server and the skills compiler, and read by *nothing* in any package — system context is
  contributed through `SystemContextContributor`, not carried on the session. All 188 sessions in the
  development store had it empty. Old data keeps the field harmlessly as an excess property, exactly like
  the already-undeclared `ownerPrincipalId`/`persona`; no migration needed.

- **`CompletionRequest.parameters` and `SingleTurnRequest.parameters` are removed.** Both were
  `@deprecated` with a note explaining that their obvious use is an anti-pattern (a per-call override takes
  control away from the provider config, where parameters belong and stay user-editable — prefer a
  dedicated provider profile). Both hosts honoured them and *no caller in the repo set them*. Shipping a
  deprecated field into a stable line means carrying it to the next major, so it goes now.

  **Reverted in 0.4.1** (see above) — "no caller in the repo" was not the same as no caller, and the
  argument did not hold for transient per-call behaviour. Do not act on this entry.

- **`MatbotRuntime.hooks` is typed `HookRegistrar`, not the `HookRegistry` class.** A plugin may only
  `register` and `removeByPlugin`; the class also carries the host's dispatch surface (`runScreen`,
  `runContribute`, `runToolCall`, `runToolResult`, `runFollowup`), which the plugin contract was
  advertising. The tell was that the per-plugin scoped facade had to be `as unknown as HookRegistry`-cast
  to satisfy its own declared type; that cast is gone. `HookRegistry` still exists, `implements
  HookRegistrar`, and lives in `/host`, where core dispatches from it.

- **`PLUGIN_API_VERSION` is `'0.4'`, and now means this package's `major.minor`.** It read `'0.1'`
  throughout 0.3.x, so it conveyed nothing — while being the one string every third-party plugin hardcodes.
  The gate is unchanged (major must match exactly; a *newer* declared minor warns and loads), so at 0.x
  this breaks nothing: an existing plugin declaring `'0.1'` still loads, which a test now pins. It matters
  at 1.0.0, where a plugin still declaring `'0.x'` fails loudly instead of loading against a contract it was
  never built for. Declare `apiVersion: PLUGIN_API_VERSION` and it stays correct for free.

### API gaps filled

- **`@matatbread/matbot-core` re-exports every branded error, not most of them.** `readOnlyError`,
  `isReadOnlyError` and the `ReadOnlyError` type were missing from core's root — `export type *` strips a
  guard's value meaning, and the explicit re-export list had been kept by hand. A consumer importing from
  core got some guards and silently missed others, including the one the turn pump itself depends on.

### Bug fixes

- **A provider call that fails mid-turn no longer discards the rounds that succeeded.** Nothing is written
  mid-turn — `runSession` commits once, at whichever terminal it reaches — so an exit that returned without
  committing threw the whole turn away. The failed-provider-call exit did exactly that, and the multi-round
  case is precisely the tool-using one: an upstream 500 or a dropped connection on round 3 lost two
  completed rounds of assistant messages and tool results that the frontend had already drawn, and that the
  next turn (which re-reads from the store) would then be missing. The same defect had already been found
  and fixed on the `toolcall`-abort exit; the shape that allowed both is gone (see the refactor below), and
  every terminal now commits through one funnel.

- **A tool-name collision can no longer crash the process or revive an unloaded plugin's tool.**
  `ToolRegistry.register` returns `void` because the no-collision path completes in the calling tick, and
  every one of its ~34 call sites fire-and-forgets. That left the collision branch — where the host may
  ask the user whether to overwrite — as the one `await` with no caller to own its outcome. A throw there
  (the settings read, or a `PromptFn` that rejects rather than defaulting, which is the documented
  non-interactive contract) was an unhandled rejection, i.e. process exit under Node's default, reached by
  the ordinary act of two plugins claiming one tool name. The branch now owns its own failure and resolves
  to keep-existing. It also re-checks the plugin's load extent before registering: `setup()` has long
  returned by the time a slow collision resolves, so an unload — or a `setup()` throw and its rollback —
  could land first and the late registration would revive a tool owned by a plugin that is gone.

- **A plugin's mount interests are dropped on unload.** `services.mounted.observe()`'s only cleanup path
  was an aborted `signal`, and `signal` was optional — so a plugin that omitted it (`storage/profiles`
  did) left a live interest behind, whose handler kept firing into a torn-down closure on every later
  quiescent edge. Because reload is unload + load, each reload generation added another one, and the mount
  table catches and logs a handler throw, so the accumulation was silent: N stale handlers doing duplicate
  work against dead state, with a stale cache able to win. The host now binds every plugin-scoped
  `observe()` to that plugin's load extent and aborts it in `unloadPlugin`, alongside the existing
  tool/hook/service removals. `MountConsumeOptions.signal` keeps working and becomes a *narrowing*
  convenience ("end earlier than my unload"), not the cleanup path.

- **`teardownPlugins` named the wrong plugin in its error log.** `Promise.allSettled` ran over the reversed
  plugin list while the log indexed the unreversed one, so a teardown failure was attributed to the plugin
  at the mirrored position. Diagnostics only.

### Optional

- Internal refactors with no behavioural change, listed because they move code a consumer may be reading:
  `plugin-api/src/types.ts` is now a barrel over `types/` (one file per domain, 18 of them — all 77
  exported names and every declaration body preserved verbatim); host boot assembly split out of
  `plugin.ts` into `host-machine.ts`; `runSession`'s six exits funnel through one commit-and-yield; the
  three copies of "fold durable context onto the user turn" became `foldOntoUserTurn` in
  `plugin-api/src/session.ts`; claiming a raced screen verdict is one step rather than two called at three
  sites; `bindPluginOps` replaces the two hand-written `ToolContext` plugin-op closures; and
  `makePluginSettings`' two near-identical CAS retry loops became one `update(mutate)`.

- `ToolContract`'s phantom fields are keyed by non-exported `unique symbol`s, so the type is
  uninhabitable — a hallucinated result shape can no longer be cast into existence. No effect on
  `ToolResultOf`/`ToolResultFor`/`ToolProxy`, which only ever `infer` through the arms.

- `unifyServices` no longer traps `has`, so `'Foo' in services` is structural rather than a registry
  lookup. The documented presence check is unchanged: `services.Foo !== undefined`.

- Docs: the five open-registry augmentation points (`MatbotServices`, `ToolContracts`, `Notifications`,
  `MarkerData`, `ProviderMeta`) are one technique, now named and explained once — in `docs/DEVELOPING.md`
  for plugin authors and `CLAUDE.md` for maintainers — with each declaration pointing at it instead of
  restating it.

## 0.3.10

### Breaking changes

- **`ProviderConfig.fallback` is removed.** It was declared in `plugin-api`, explicitly parsed out of
  `matbot.yaml` by the config loader, and copied field-by-field through the node app — and read by
  nothing, in any package. Nothing changes at runtime, because nothing ever consulted it; what goes away
  is a config surface that silently did nothing. Someone could set `fallback: other-profile` on a
  provider, get no parse error and no warning, and reasonably conclude that a failing provider would
  fail over. Removed rather than implemented because failover is a real design question — it has to
  decide how two providers billed for one turn are accounted, and what happens to a tool-call's
  `ProviderMeta` round-trip token when the retry lands on a provider that never issued it — and a
  stub answering none of that is worse than nothing. An existing `fallback:` key in a config is
  ignored exactly as before.

### API gaps filled

- **A tool call cut off mid-arguments is now a recoverable round, not a dead turn.** When a response hit
  its token limit part-way through a large tool call, the adapter threw — `Tool "x" arguments could not
  be parsed … increase the provider's maxTokens` — which ended the whole turn. Raising `maxTokens` only
  moves the ceiling; it cannot survive one call larger than the new ceiling, so the user got a dead end.
  The `tool-call` `CompletionEvent` now carries an optional `truncated: { bytes, stopReason? }`, and the
  runner answers such a call with an error result **without executing it** (`input` is `{}` — the real
  arguments are unrecoverable, and the wire requires an object). The model reads the failure in the slot
  it expects and retries smaller, which is the self-correction the loop already performs for a rejected
  or unknown tool.
  - **No retry counter.** A model that keeps overflowing burns rounds and meets `maxRounds`, exactly as
    one repeatedly calling any failing tool does. One bounding mechanism, not two.
  - **The pairing is what makes it safe**: the assistant message carries a `tool-call` block for the
    severed call, and an unpaired `tool_use` is rejected by the next submission.
  - **`toolresult` runs for it** (`toolcall` does not — there is nothing to judge, the call cannot
    proceed whatever a hook says). That is the seam for advice the harness cannot have: *which* of a
    given tool's parameters offers a cheaper edit is the tool author's knowledge, not core's. Narrow
    with the exported `isTruncatedToolResult` rather than duck-typing the result.
  - Detectable only where arguments stream as a severable JSON *string* — the Anthropic
    (`input_json_delta`) and OpenAI (`function.arguments`) shapes. Gemini delivers each `functionCall`
    complete with `args` already an object, so there is nothing to sever; `chatjimmy` and
    `customer-services` emit no tool calls at all.
- **A response cut short is recorded instead of vanishing.** A new `truncated` `CompletionEvent`
  (`reason: 'max-tokens' | 'stream-end'`) reports that the provider stopped the response rather than the
  model choosing to. The far commoner case has no tool call in it at all — prose stopping mid-sentence —
  and matbot surfaced that nowhere: the stop reason was read and then used only in an error message that
  fired for tool calls alone. The runner persists it as a `matbot-truncation` marker and carries it
  live. Marker-role deliberately: a reader and an audit see it, the model does not — its own text is
  already truncated in the transcript, and a block telling it so invites narrating the cut-off rather
  than continuing past it. Acting on it (continue, re-ask with a larger budget) is a `followup` hook's
  business. Emitted by the anthropic, openai-compat and google adapters; the two text-only adapters
  expose no finish reason to report.
  - Note for anyone switching exhaustively over `CompletionEvent`: it has a new arm.
- **`ProviderConfig.maxRounds`** — an optional per-profile ceiling on the agentic rounds one turn may
  take, a round being one provider call plus the tool batch it asked for. Reaching it ends the turn
  (`aborted`, reason `round-limit: …`) instead of starting another round; absent ⇒ unbounded, which is
  the previous behaviour, so nothing changes for a config that does not set it. The runner's loop had no
  upper bound at all, so a model/tool feedback cycle could run until an external timeout or a user
  cancel.
  - **On the provider profile, not global and not per-call**, because that is the unit spend is
    denominated in: a local model can afford to grind where a frontier model at 100× the rate cannot,
    and one deployment runs both. It is a sibling of `model`/`endpoint` and deliberately **not** a
    member of `parameters`, which is forwarded to the endpoint unmodified — this never leaves matbot.
  - **In core rather than as a hook**, because a ceiling reached through a plugin is a ceiling that
    disappears when the plugin fails to load, and because expressing it as a hook turned out to require
    three non-obvious things of every consumer: deriving the round number, knowing that `rejectTool`
    does not actually bound the loop (it only feeds an error back — an uncooperative model keeps
    driving full-history provider calls), and therefore staging a soft nudge ahead of a hard stop. That
    is a great deal of subtlety for what should be a number.
  - Validated at the config boundary: a non-integer or `< 1` value is rejected with a clear message
    rather than clamped, since silently treating `0` as "no turn may do anything" would read as a
    broken provider. Settable and visible through the `provider` tool's `add`/`list` as well as
    `matbot.yaml`.
- **A tool can hand the model something to look at.** New `model-content` `ToolEvent`, carrying
  `ModelContent[]` (the inline `image` / `document` / `audio` arms of `MessageContent`). The runner pins
  the media directly after the tool message it answers and splices it into the outgoing copy for the
  rest of the turn. Previously a tool could return only what the model *reads* — its `result`, serialised
  as JSON — so an image or a PDF could reach the model by no route at all.
  - **Wire-only: never persisted.** The transcript records what the tool returned, not the bytes it
    showed, so a session does not accumulate base64 and there is no exit path that has to remember to
    strip it. A later turn needing the bytes again calls the tool again — the same pull the model
    already performed.
  - **Rest-of-turn, not next-call-only.** Withdrawing content the model has already seen breaks the
    prompt cache from that point and leaves it referring to something no longer there. The cost
    corollary: a large document is re-sent on every subsequent round, so hand over the smallest thing
    that answers the question, and note that `maxRounds` bounds how often it is paid for.
  - **No new service and no `FileStore` dependency.** Where the tool got the bytes — a `FileStore`, an
    HTTP fetch, a chart rendered in memory — is the tool's business; core carries them to the wire and
    drops them. `files` is optional on both `RunSessionOpts` and `ToolContext`, so routing media through
    it would have made multimodal impossible without one.
  - Deliberately *not* a `PipelineEvent`: nothing durable backs it, so a frontend that drew it live
    would show something that vanishes on reload. A tool that wants the user to see it too has `file`
    and `marker` already.
- **`document` reaches Anthropic and Gemini natively.** It degraded to a `[Document: name]` text
  placeholder in every adapter — the block existed in `MessageContent` and no provider ever received
  one. Anthropic now gets a native `document` block (base64 for `application/pdf`; `text/*` decoded into
  a plain-text source, which is the shape that surface takes); Gemini gets `inlineData`, which also
  covers `audio`. Anything Anthropic has no representation for keeps the placeholder. `openai-compat`
  is unchanged: it fronts DeepSeek, vLLM, ollama and llama.cpp as well as OpenAI, and the file/audio
  parts are not portable across them.

### Bug fixes

- **`followup` now runs only for a turn that actually committed.** It is documented as post-commit and
  the code said it was "skipped on abort", but the gate was `!ac.signal.aborted` — which knows about the
  two signal-driven aborts (a steer, a user cancel) and not the policy ones. A `screen` hook or a
  `toolcall` hook refusing a turn, and any turn ending in `error`, therefore still got a followup pass
  over history containing no completed response, where a hook judging "the assistant's answer" was
  reading the previous turn's. Worse, a `resubmit` from there undoes the stop that just happened: for
  the new `maxRounds` ceiling it would have handed out a fresh budget, making the limit worth up to
  `MAX_RESUBMIT_DEPTH` times what was configured. The pump now tracks which terminal event the turn
  ended on and runs `followup` only for `done`. A hook that wants to observe a failed or interrupted
  turn should publish on the `Notifier` from wherever the failure arises, which is where that fact
  actually is.
- **A `toolcall` hook returning `abort` no longer discards the whole turn.** It was the one terminal
  path in the runner that returned without persisting, and nothing is written mid-turn — so a hook
  aborting on a late round threw away every earlier round's assistant message and tool results along
  with the current response, all of which the frontend had already drawn. A reload showed a bare user
  message. The turn is now committed before the `aborted` event.
  - Committing it requires closing the `tool_use`/`tool_result` pairing, since the assistant message
    carries a `tool-call` block per pending call and an unpaired `tool_use` is rejected by the next
    submission (Anthropic 400s; nothing downstream reconciles them). An abort is a turn-level stop
    rather than a verdict on the tools, so the call the hook judged and any later calls in the same
    round are recorded as not-run.
  - The judged call now also gets its `tool:end`. Previously `abort` returned between `tool:start` and
    `tool:end`, leaving a frontend with a tool bubble that never closed.
- **`complete()` no longer loses the input and cache token counts of an out-of-band completion.** Both
  hosts accumulated the response's usage by overwriting on each `usage` event rather than folding, but
  an adapter may report one call's usage in several parts: the anthropic adapter sends input and cache
  counts on `message_start` and output tokens on `message_delta`. Last-event-wins therefore returned
  `inputTokens: 0` with no cache figures for every `complete()` / `singleTurn()` against an Anthropic
  provider — `single_turn`, a classifier, a titling pass, anything a plugin runs off-conversation — and
  the same zeroes went into the ambient usage sink, so a tool's attributed spend under-reported too. The
  loop now folds with `addUsage`, exactly as the runner has always folded a turn's usage, so the two
  accounting paths agree. Adapters that report one cumulative event at end of stream (google, chatjimmy,
  and OpenAI-compatible endpoints) are unaffected: folding a single event equals overwriting it.
- **The anthropic adapter no longer emits adjacent same-role messages.** It rendered one wire message
  per neutral message, so any two neighbours that landed on the same role went out as-is — which the
  Messages API does not accept. It was reachable before this release (an assistant turn stripped back
  to text by a thinking-block elision, next to another assistant turn) and is reachable by construction
  now that tool-supplied media follows a tool message, itself rendered `user`. Adjacent contents fold
  into the previous message, which is what the google adapter has always done for the same reason.

### Optional

- **storage/filesystem — a document id that isn't filename-safe is escaped, not rejected.**
  `FilesystemStore` validated ids against `^[\w-]+$` and threw `Invalid store id` for anything else,
  but a `Store` id is an arbitrary string: a skill keyed `scope:name` and user-scoped state keyed by
  email address are both unstorable, so every `get`/`set` for them threw at runtime. Anything outside
  `[A-Za-z0-9_.-]` is now percent-escaped for the filename instead (`.` left readable — it cannot
  traverse, since a `.json` suffix is always appended, making an id of `..` the file `...json` inside
  the store directory). The set that was previously allowed escapes to itself, so existing documents
  keep their filenames and there is no migration; `%` cannot occur in one of those older names, so the
  two eras cannot collide. Escaping is one-directional — nothing decodes, because `query` reads each
  document's `id` from its own contents.
  - **`query` enumerates them too.** Its directory filter was the same narrow `^[\w-]+\.json$`, so an
    escaped id would have been written but then skipped by every listing — the widened filter still
    excludes the `<name>.json.tmp` scratch files an atomic write leaves behind.
  - **A write now invalidates its own parse-cache entry again.** `forget()` built its key from the raw
    id while `remember()` keys on the on-disk name; for an id that escapes to something else the two
    diverged, so `set`/`delete` stranded the stale entry and a subsequent `immutable` query served the
    superseded document.

## 0.3.9

_Provenance stops citing itself, and says which of a claim's terms it actually found. Plus: the
Anthropic adapter no longer discards a thinking block delivered whole on its opener, and the provider
tools stop presenting their parameter list as a closed set._

### Optional

- **provenance — a tool can be excluded from the search pool, and `determine_provenance` excludes
  itself by default.** Its own results are verdicts *about* claims rather than observation of the world,
  so a second pass over a session it had already judged found its own prior output and cited it as
  evidence for the very claim that output was a verdict on — circular, and confidently so, since the
  extract genuinely does contain the claim's every key. The exclusion list resolves at three levels:
  the `ignoreTools` call parameter, then a pin held by `provenance_config`, then the coded default
  (`["determine_provenance"]`). An explicit empty array at either settable level means "include
  everything" and is distinct from omission, which falls through to the next level; the same
  three-level shape also serves suppressing a verbose tool whose output is noise rather than record.
  Only tool output is filtered — `USER` messages never are, because a user quoting a tool result is
  still the user speaking, and the quotation is legitimate provenance for what they were told.
  `provenance_config` now carries both settings: `set` takes `provider` and/or `ignoreTools` (at least
  one, each validated independently), `get` reports the current values *and* the coded default so a
  caller can see what it is overriding, and `clear` resets both.
- **provenance — a strict-key veto is its own verdict, and every result says which keys were found.**
  A caller-supplied key appearing nowhere zeroes the search (it always did — material found on the
  *other* keys would read as corroboration for a term the session does not mention), but the empty
  result was then indistinguishable from finding nothing at all, and the two mean opposite things:
  "this specific term isn't here" is a located absence, "nothing bearing on this is here" is a diffuse
  one. The first is now reported as `vetoed`, skipping both the reader and the cold probe — the veto is
  about session content, not about the model's prior, so re-asking the model would answer a different
  question. Alongside it, every verdict carries `keyHits`: per key, whether any spelling of it was seen
  and which sources it was seen in (`USER`, `TOOL:<name>`). On a composed claim that is the part a
  verdict alone cannot express — which terms are retrieved and which are fabricated — and a `vetoed`
  verdict names its offender as the entry with `found: false`. The tool description now asks callers to
  split composite terms into their discriminating parts, so the veto can pinpoint rather than merely
  fire.
- **providers/anthropic — a thinking block delivered whole on its opener is no longer discarded.** The
  stream handler seeded `{ thinking: '', signature: '' }` on `content_block_start` and filled it from
  the subsequent deltas, which is what the Anthropic API itself sends; an Anthropic-compatible gateway
  that puts the entire payload inline on the opener and sends no deltas therefore stored an empty
  block. The opener's own `thinking` and `signature` are now the seed, so both shapes round-trip.
- **provider tools — the `PARAMETERS` list is labelled as an example, not a schema.** Both the node
  `provider` tool and its browser counterpart list `maxTokens` / `temperature` / `topP` under a heading
  that read as the permitted set, so anything absent from it looked unsupported. `parameters` is passed
  to the endpoint unmodified and its contents are model- and provider-specific; the heading now says so.

## 0.3.8

_One notification bus replaces every bespoke "something changed" channel. Three private streams are
deleted outright; the web UI reads one stream; live session/file/skill/share updates now reach a
second browser. Also: a new `provenance` plugin traces a claim to the tool result or user message it
came from, and a running turn now owns its session document rather than losing edits to it silently._

### Breaking changes

- **`ToolRegistry.watch()` and `watchPlugins()` removed**, with `ToolRegistryEvent` and
  `PluginRegistryEvent`. Both registries were broadcasters over the same primitive the new bus is, so
  keeping them was duplication rather than layering. They publish a `RegistryChange` with
  `registry: 'tools' | 'plugins'` instead, and consumers subscribe to `services.Notifier`. A `tools`
  notification carries the registering plugin's name in the advisory `detail`; resolve the name for
  anything authoritative. `SkillManager.watch()` went the same way.
- **`FileStore.watch()` removed**, with `FileEvent` and `WatchVisibility.watchFiles`. It existed to
  detect writes made outside matbot — but matbot writes `.data` and nothing else, and every in-process
  writer now announces itself, so no first-party feature depended on it. As a core interface it was
  actively misleading: only the filesystem store implemented it, sqlite re-broadcast its own writes
  (which the bus already carries), and Drive and OPFS returned a stream that yields nothing — making
  "this backend cannot watch" indistinguishable from "nothing has changed". Watching arbitrary
  filesystem activity is a plugin's job: it can watch whatever it likes and publish onto the bus, which
  every sink already understands. `WatchVisibility` keeps `visible()` — the part that was ever a
  contract rather than a transport.
- **The `StoreChange` envelope is removed from `types.ts`.** The self-describing change shape that the
  partitioned CRUD streams passed around is superseded by `ItemChange` on the bus, which carries the
  same `namespace`/`id`/`operation`/`detail` plus attribution and ownership. Nothing reads the old
  envelope any more.

### API gaps filled

- **`Notifier`** — a swappable `MatbotServices` member with an in-process host default:
  `notify` / `subscribe` / `consume` over one `Notification` envelope. Matbot owns the envelope and the
  registration surface, not delivery: no persistence, no replay, no delivery guarantee, so a sink
  re-queries on attach and treats a notification as invalidation. Within a plugin's `setup()` it is
  scoped, so published notifications carry that plugin's name.
  - The envelope discriminates on `kind` (the shape — `ItemChange`, `RegistryChange`, or an
    augmentation of `Notifications`) *and* carries attribution (`instance` / `plugin` / `source`) as
    separate fields, so a sink can filter on either or both. `principal` is ownership — whose data
    changed, the input to `WatchVisibility.visible` — and is never conflated with the producer fields.
    `kind` is **open at runtime**, so a `switch` over it must always have a `default`.
  - **A `kind` is `<package-name>#<InterfaceName>`** — `'@matatbread/matbot-plugin-api#ItemChange'`,
    `'@matatbread/matbot-plugin-api#RegistryChange'`. Unlike a type name, a `kind` is globally scoped
    and an importer cannot rename it out of a collision: two plugins choosing the same bare word is an
    unfixable declaration-merge conflict in `Notifications`, and across a bridge it is a silent
    mis-narrowing of one instance's payload into another's shape. The package name, already unique,
    does the qualifying, and it names the package that *defines* the shape, never the one emitting it
    (`plugin` is the emitter; four plugins emit `ItemChange`). `ItemChangeKind` and `RegistryChangeKind`
    are exported from `plugin-api` and re-exported by `core`, so a consumer gets a renameable handle
    back: `import { ItemChangeKind as Changed }`.
  - **An arm never declares `kind`.** `NotificationBase` has no such field; `Notification` grafts each
    arm's `Notifications` key on, so the tag cannot disagree with the key it is registered under. An
    augmenting plugin declares its interface, registers it under `'<package>#<Name>'`, and is done.
    `NotifyInput` rejects an unqualified key at the `notify` call site (in the compilation that declared
    the augmentation, since the mapped type resolves at the use site), and `createNotifier` warns at
    runtime for the producers TypeScript never sees: a plain-JS plugin, or a bridge injecting a foreign
    instance's traffic.
  - **Identity, never value.** An `ItemChange` carries `namespace`/`id`/`operation`; `detail` is
    advisory (a cosmetic in-place UI update at most). Events are stale the moment a concurrent writer
    lands, so consumers read through the store. Publish `ItemChange` for any invalidation of an
    addressable item, whatever holds it — a `Store`, a `FileStore`, a share that passes through neither;
    define a kind of your own only when you carry something a consumer cannot get by re-reading
    (progress, a measurement), which `detail` is not the place for.
  - **Distributed left open, not built.** A registered implementation may forward off-box; it stamps
    `instance` on ingress and must not re-forward a foreign `instance` — that is the loop break.
- **`notifyingStore(store, notifier, namespace, source)`** — wraps a store so every successful write
  announces itself. For a namespace with one writer an explicit `notify` is clearer; this is for one
  with many (`sessions` has nine), where it cannot be forgotten by the next writer to arrive.
- **`StoreQuery.immutable`** — the caller's promise not to mutate the documents a query returns,
  which frees a backend to hand back shared instances rather than freshly-materialised ones. A pure
  optimisation hint: a backend may ignore it and nothing changes, so it is never load-bearing for
  correctness. Set it only where the promise is actually kept — a read-modify-write path (pull a page,
  edit a document, `cas` it back) must not, since the instance it edits may be one another caller is
  still reading.
- **`ComposedCallContext`** — the read-only identity of the call a composed function is running under
  (`callId`, `sessionId`, `provider`, `workdir`, `signal`), for hosts that inject a calling surface into
  model-authored code. Deliberately much narrower than `ToolContext`: identity, not capability, so
  `vault`, `files`, `prompt` and plugin (un)loading stay reachable only through tool contracts. A tool
  with real source still takes `ToolContext` and needs none of this.

### Bug fixes

- **Changes that had no channel at all now have one.** A session created, renamed, archived or
  auto-titled in one browser reaches another; a first share or an unshare reaches the recipient's list;
  a file deletion is representable (`FileEvent` had no operation, and the filesystem watch dropped
  deletes entirely).
- **Deleting a shared-in item un-shares it.** The profiles backend routes a `Store.delete` (and a
  `FileStore.delete`) of an item shared INTO the current partition through its own `unshare` path,
  rather than relying on the raw unlink happening to spare the owner's file: the shared-in cache is
  updated and the change announced, where before both were stranded. No API change — a delete is a
  delete to the caller, which may not have profiles loaded at all; only that layer can tell the two
  apart.

### Optional

- **function-tools — defined functions move from plugin settings to a `functions` store. Existing
  definitions are NOT migrated in code and will be lost.** Settings is a key-value bucket for
  configuration, held as one document per plugin: every `define` read-modify-wrote the plugin's entire
  settings document to append to an unbounded array (27 KB in one real install), two concurrent defines
  clobbered each other wholesale, and the set was invisible to the notification bus. Each function is now
  its own document in the `functions` namespace, keyed by its name — writes are per-function and
  independent, `list` reads through the store proxy instead of an in-memory snapshot (so it follows a
  backend swap and the current principal's partition, and sees a second writer), and define/remove
  announce themselves as `ItemChange` like every other stored thing. The plugin also re-registers its
  tools when a deferred `StorageBackend` swap lands, which it previously never did — the compiled tools
  were whichever set the backend held at boot. One behavioural consequence: `settings` is pinned to the
  base partition and can never be isolated per profile, so defined functions were unavoidably global;
  `functions` is an ordinary namespace, so a profile can now isolate (or share) its own set. To carry
  definitions across the upgrade, copy each entry of the old settings `functions` array into
  `.data/functions/<name>.json` as `{ id: <name>, version: <ms>, definition, description? }`, or
  re-`define` them.
- **provenance (new plugin) — `determine_provenance`.** Traces where a claim came from rather than
  whether it is true. Provenance, unlike truth, is a *closed* question: anything not in the session came
  from the model's weights or from nowhere, so the session is already the provenance record and the
  answer is found by searching it — never by asking the model how it knows, which it cannot answer
  (recall and invention are the same event from the inside). Per claim it returns `retrieved` (a tool
  result carries it), `given` (the user said it), `derived` (computable from material that is here),
  `model-prior` (absent here, but the model asserts it cold — measured by re-asking the same model with
  none of this context), or `unsourced`, with the extracts the verdict rests on quoted verbatim so it can
  be checked rather than trusted. `unsourced` means NOT SOURCED HERE, never false: training data is a
  legitimate origin and the policy for an unsourced claim belongs to the caller. Tool results are split
  into units — one per `items[]` entry, per table row (carrying its header), per bullet — and matched
  whole-word on the claim's keys, so nothing is ever decided by a positional cap; the single budget sits
  at the prompt boundary, spent best-ranked-first, and an over-long extract is windowed on its match. The
  reading runs on the pinned `classifierProvider` or the turn's model; the cold probe always uses the
  turn's model, since it is that model's prior being measured. `provenance_config` (get/set/clear) pins
  the reader onto a small/fast model, refusing a provider that is not configured; it deliberately cannot
  reach the probe. Bundled into the browser artifact (on-demand, not auto-loaded), since the plugin uses
  no Node primitives.
- **edit-session — editing the running session is refused instead of silently discarded.** `session_edit`
  reported success for a `cut`, `split` or `compact` aimed at the session the calling turn was running in,
  and nothing survived: the runner takes one in-memory copy of the session at turn start and writes it back
  at turn end, so the tool's committed CAS was overwritten moments later. `split` failed worst — its new
  session survived while the truncation of the original did not, leaving a dangling half. The three
  destructive actions now error on the current session, naming why; `fork` still works there (it writes a
  new document), though it forks the committed state without the turn's uncommitted tail. Editing any other
  session is unaffected.
- **function-tools — an apostrophe in a comment no longer breaks `define`.** The scanners locating a
  definition's parameter list and body tracked string literals but not comments, so a possessive or a
  contraction in prose (`another conversation's provider`) opened a string that swallowed the rest of the
  source. The body was then unlocatable and the author was told the *return type* was missing — an error
  about a line they had written correctly, which `noTypeCheck` could not bypass because it is raised
  before the type-check. The field report had bisected it down to "comments containing colons or
  em-dashes", both of which parse fine; a single `'` was the whole cause. All four scanners now skip
  strings, templates and comments through one helper. Three fixes fall out of the same root: a comment
  ahead of the definition is trivia rather than "not a function definition" (it also no longer lands
  between `function` and the name at compile time), a comment inside the parameter list stays out of the
  parsed parameter type, and an unlocatable body now says so instead of blaming the signature.
- **function-tools — a quote inside a regex literal no longer loses the whole tool.** The signature
  scanner skipped strings and comments but read regex literals as code, so the apostrophe in
  `/[A-Za-z'-]+/` — or the odd third double quote in `/"[^"]+"/` — opened a string that swallowed the
  rest of the definition. The failure is worse than the comment case it mirrors: `define` blames brace
  balance, and on reload the tool is simply absent, with nothing logged and no partial registration to
  notice. Regex literals are now inert like strings and comments, told apart from division by the
  preceding significant token, with `/` inside a character class not ending the literal.
- **function-tools — a composition can now be silent.** A composition always yielded a `result`, even
  when it returned nothing, so `undefined` reached the model as a result rather than as the absence of
  one. That made the observational-dispatch contract unreachable from userland: the triggers dispatcher
  fires on a yielded result, so a composition used as a trigger's `invoke` could never be the silent
  side-effect the contract describes — every fire woke the model, including the ones whose verdict was
  "nothing to do here". A composition returning `undefined` now yields no `result` event, like any
  hand-written tool whose work is a side-effect (result-less tools were already expected downstream —
  the Anthropic converter names one). Declare the return type as `T | undefined` to use it.
- **function-tools — a composition can read the call it is running under.** `tool` and `toolInContext`
  carried the calling context *downwards* — every `await tool.x(…)` already inherited the session — but
  exposed none of it to the body, so a composition could not name the session it was in, and no tool
  reports it (`session_action` takes an explicit `sessionId`; `whoami` returns a principal). A third
  injected binding, `context`, now sits beside them, rebuilt per invocation so a `define`d function
  compiled once still reads the session it is currently running under. It is declared in the generated
  dts rather than only described in the tool description: that same string backs the type-check gate, so
  prose alone would have produced bodies that fail the check they were told to write against. A
  parameter named `tool`, `toolInContext` or `context` is now rejected by `define`/`lambda` — as a
  duplicate formal it silently shadowed the injection (last binding wins) instead of erroring.
- **frontend/web — one notification stream.** Replaces `file-changed` / `skill-changed` /
  `tool-changed` / `plugin-changed`, with matching in-process wiring in the browser transport, and
  re-lists sessions live. `session-busy` deliberately stays its own event: it replays current state on
  connect, which the bus does not carry. `GET /events/files/:ns/:name` is removed (no consumer); the
  multiplexed `/events` stream still carries every file notification.
- **frontend/web — an interactive prompt answered in another browser.** `prompt-resolved` is emitted
  from the settle path every answer, cancel and abort funnels through, and the UI retires its dialog on
  it. The prompt case no longer *awaits* the answer inside the turn's event loop: parking there stalled
  every later event of that turn in the other browsers — including the `prompt-resolved` that would
  have retired their dialog.
- **frontend/web — a shared-in session's `×` unshares** instead of archiving it (an archive is a write,
  which raised `ReadOnlyError` once shared-in sessions appeared live in the list); rename is withheld
  there for the same reason.
- **frontend/web — one session list per change, not one per notice.** Every mutation used to list the
  sessions twice: the click handler listed immediately, and the change notification that same write
  published listed again, re-rendering a sidebar that had already settled — new with the bus, since
  sessions had no live channel before. All triggers (click, fork, split, new session, and the end of
  every completed turn) now funnel through one trailing-debounced `refreshSessions()`; nothing depends
  on the notification arriving, so a disconnected stream degrades to the old behaviour rather than a
  stale list.
- **frontend/web — a stale tab reloads itself.** Every response carries the running harness version as
  `x-matbot-version` (exposed via CORS, so a cross-origin page can actually read it), and the HTTP
  transport compares it against the version the page loaded with — the one already on screen in
  `#matbot-version`, which app.js fills from `about_matbot` at bootstrap, so there is one version line
  and nothing extra stamped into the page. On a mismatch the page reloads once. A server restarted on a
  new build no longer leaves a long-lived tab running UI code against an API it no longer matches.
  Static assets are served `cache-control: no-cache` so the reload re-fetches them rather than replaying
  the stale copy that triggered it.
- **workspace, background — writes and deletes announce themselves**, carrying the content namespace
  and name so a frontend can update a row in place rather than re-listing.
- **storage/filesystem + sessions — listing sessions no longer re-parses every conversation.**
  `Store` has no projection, so `session_action list` read and JSON-parsed every session document
  whole — every message of every conversation — to produce four summary fields per row: 591ms for
  52MB across 213 sessions, on every sidebar refresh. `FilesystemStore` now honours
  `StoreQuery.immutable` with a parse cache validated by a fresh `stat` (mtime + size) on every query,
  so a document written by another process — a detached background job, an editor — invalidates
  exactly like a local write, and a stale entry cannot outlive the stat that disagrees with it; writes
  through the store additionally drop their own entry, closing the same-timestamp window. Bounded at
  64MB of source bytes, least-recently-used evicted, so a larger store degrades to the previous
  behaviour for the overflow instead of growing without limit. Warm listing: 6ms.
- **triggers — a trigger can carry a cool-down.** `Trigger.cooldown` (`{ maxPerTurn?, quietTurns? }`)
  rate-limits *firing* independently of *matching*, because a rule can be correctly matched turn after
  turn while acting on it every time is a spin rather than a service. The `retract` kind had a
  convergence guard; `followup` had nothing, so a critique-style trigger could fire on turn after turn
  — its own consequence being the very thing its rule matches. Both limits are counted from the durable
  fire markers already in the session, so a cool-down survives restart, reload and a backend swap with
  no in-memory state, and only *result-bearing* fires count (a silent side-effect trigger such as
  `remember_fact` never spends budget). A held-off trigger leaves a `suppressed` marker with cause
  `cooldown` naming the reason — suppression is never silent. Absent ⇒ unlimited, which stays the
  default. Settable via `trigger_action` add/update (`null` on update clears every limit), and editable
  in both of the web frontend's trigger editors.
- **cognition — the Inner voice trigger ships with `{ maxPerTurn: 2, quietTurns: 1 }`**, backfilled
  onto installs seeded before the field existed (skipped if the field was since tuned or cleared).
- **rumsfeld — `find_fact` and `contextual_search` descriptions disambiguated**, so the model stops
  reaching for one where it wants the other.

## 0.3.7

_A single provider fix: the Anthropic adapter's prompt caching now survives interactive think-time gaps and agentic tool loops._

### Optional

- **providers/anthropic — prompt caching now survives interactive use.** On-disk session usage put this
  adapter at ~43% cache hit against 91% for a server-auto-cached provider, from two causes. The 5-minute
  cache TTL expired across ordinary think-time gaps (~81% cold miss at 5-30min, ~100% beyond), and the
  message breakpoint was only placed when the second-to-last *user* turn ended in a `text` block — so
  tool-result turns (role `user`, last block a `tool_result`) got no breakpoint at all, leaving agentic
  tool loops uncached. Both re-processed the whole prefix as fresh input, inflating input-token throughput
  against the endpoint's rate limit. The adapter now defaults to the 1-hour TTL
  (`{ type: 'ephemeral', ttl: '1h' }` + the `extended-cache-ttl-2025-04-11` beta), with
  `parameters.cacheTtl: '5m'` to opt back; the message breakpoint is placed on the last block whatever its
  type and rolls across the two most-recent messages (advancing the write frontier while keeping the
  earlier breakpoint inside the 20-block lookback); and the system prompt is sent as a block array with its
  own breakpoint, anchoring tools + system together even when a long tool turn pushes the message
  breakpoints out of lookback range. Common case: 4 breakpoints, Anthropic's maximum.

## 0.3.6

_A single core fix: a provider profile that names its adapter by a different specifier than a sibling profile no longer intermittently fails to resolve._

### Bug fixes

- **Two provider profiles naming one adapter by different specifiers no longer knock each other out.**
  The provider-factory registry is keyed by canonical plugin name, but `instantiateProvider`'s
  specifier→name fallback only matched the exact literal string a plugin was loaded with. So a profile
  written as a path (`./plugins/providers/openai-compat`) and one written as the package name
  (`@matatbread/matbot-provider-openai-compat`) missed each other: whichever was used first loaded the
  adapter, and the other force-loaded it again and died on "Plugin … is already registered", surfacing
  as `provider "…" has no loadable adapter`. Which profile broke depended on use order within the
  process, making it look intermittent. `instantiateProvider` now derives the canonical name through the
  host `PluginResolver` before force-loading. Stored profiles are still never rewritten.

## 0.3.5

_Two runner-level turn-control features — mid-turn steering (interrupt a running turn and redirect it) and concurrent screen-phase classification (race a verdict against the turn instead of gating the first token on it) — plus the completion of the multi-profile storage work released in 0.3.4: item-grain sharing now spans files as well as documents, a shared item stays live in every viewer's UI, and the tool vocabulary around stored files is disambiguated._

### API gaps filled

- **Mid-turn steering — a submission arriving while a turn runs can now interrupt it.** `SubmitOpenOpts`
  gains `mode: 'queue' | 'interrupt' | 'auto'` (default `queue`, backward-compatible). `interrupt` stops
  the running turn — keeping its committed partial work (the agentic loop already commits coherently on
  abort, so no dangling tool-call) — and runs the new message next with a "keep going, noting the above"
  nudge, rather than waiting for the turn boundary. The decision is made inside the runner, synchronously
  against the running state, so an interrupt can never land on a later turn. A new optional
  `SteeringPolicy` service (`MatbotServices`) drives `mode: 'auto'`: its `classify` (regex / semantic /
  LLM — not assumed to be an LLM) decides queue vs interrupt and its `nudge` supplies the continuation
  nudge; absent ⇒ host defaults (`DEFAULT_STEERING_POLICY = 'interrupt'`, built-in nudge). A new
  `PipelineEvent` variant `steer` announces the interrupt so a frontend places the new bubble and reads
  the imminent `aborted` (reason `'steer'`) as a yield. A tool that errors while the turn is aborted no
  longer leaks the raw abort reason into its result — the runner records a neutral "interrupted before
  completion" message so the continuation turn doesn't reflexively re-run a side-effecting tool.

- **`ScreenResult.deferred` — a raced screen verdict the runner folds in without gating the turn.** A
  new `DeferredScreen { claim(): DeferredCorrection | undefined }` lets a `screen` hook start expensive
  work (e.g. a classifier judging the user message) concurrently and return immediately, handing the
  runner a poll handle instead of blocking. The runner polls `claim()` — synchronously, never awaited —
  at each turn-loop edge: before each provider call, on every stream event, and just before commit. The
  first time it returns a correction (the work settled), the runner **discards the uncommitted
  in-progress response and re-runs the loop with the correction folded in** — an in-situ redo, no store
  pop and no retraction marker, cheaper than a post-commit retract. Because the mid-stream poll runs
  before each event is emitted, a verdict faster than time-to-first-token is caught before any token
  reaches the frontend; a slower one aborts the in-flight provider request (a per-call `AbortController`
  linked to the turn signal) to stop backend generation. `claim()` is exactly-once — a hook uses that
  single delivery to coordinate the in-situ path with its own post-commit fallback, so a verdict is
  never delivered twice.

- **`DeferredCorrection { ephemeral?, durable? }` and `FollowupResult.retractAndRerun.durable`.** A
  claimed correction — and a post-commit retract — can now carry `durable` blocks folded onto the turn's
  user message (persisted, marked `origin: 'robo'`, carried live as a `robo-user` event) as well as, or
  instead of, `ephemeral` tail-fold blocks. This preserves a durable-context correction's persistence
  even though the verdict now lands mid-turn (in-situ) or post-commit (retract) rather than before
  generation. `retractAndRerun.context` is correspondingly optional (a durable-only retract).

- **`StoreChange { operation, namespace, id, detail? }` — a self-describing store-change envelope.** A
  partitioned change now names its own routing namespace and id, so a consumer filters an event without a
  per-stream namespace constant compiled in. `WatchVisibility.watchFiles` yields `Routed<StoreChange>` in
  place of `Routed<FileEvent>`, and `visible()` gains an `id` parameter
  (`visible(viewer, namespace, id, origin)`) so visibility is decided per item rather than per stream —
  which is what lets one firehose carry every partition's changes, filtered per connection.

### Optional

- **frontend/web: opts into steering.** `POST /sessions/:id/submit` accepts `mode`, defaulting to `auto`
  (interrupt-by-default with no policy registered). The UI adds a queue↔interrupt toggle beside the
  provider select, renders the `steer` event as its user bubble live, and no longer re-renders the
  session from the interrupted turn's `aborted` snapshot (which lacked the not-yet-persisted steer message
  and wiped the live bubble until a manual refresh). Other frontends are unchanged (runner default `queue`).

- **triggers: the user-phase classifier races the turn instead of blocking the first token.** The
  `screen` hook kicks off classify+dispatch concurrently and hands the runner a `DeferredScreen` rather
  than awaiting the verdict; the correction is delivered on whichever path wins — a pre-first-token grace
  inject, the runner's in-situ restart, or the post-commit `followup` retract. This removes the
  classifier round-trip (~2.5s) from the critical path of the ~90% of turns where nothing fires, while a
  fire still corrects the turn: a `contextual` fire folds durably onto the user message, an `ephemeral`
  fire tail-folds — on all three delivery paths. A result-fire that lands after commit still supersedes
  the answer via the existing retract-redo. New `classifierGraceMs` setting (default `0`): `0` is a pure
  race (no added latency); a positive value holds the first token up to that long so a fast classifier
  injects cleanly before generation rather than racing it — one knob spanning fully-responsive to
  fully-clean. A raced verdict is traced by a `user-insitu-fired` marker (clean path, no retraction
  marker exists) or `user-retract-fired` (post-commit).

- **triggers: a followup fire records why it fired.** A `followup`-kind trigger now leaves a durable
  marker naming the condition that matched, so a resubmitted robo turn is traceable rather than appearing
  unprompted.

- **storage/profiles: item-grain sharing spans files, and gains `copy`.** `share`/`unshare`/`ownerOf`
  handle the `files` axis — a file is a data + `.meta.json` PAIR on disk, so sharing links both into the
  target's file area, reads flow through the symlinks to the owner's live file, and `ownerOf` reports the
  owning profile. A shared-in file is **read-only**: a `put` under the shared name throws `ReadOnlyError`
  rather than forking the data and writing through the meta symlink to the owner. A new `copy` action
  writes an independent duplicate the target fully owns, preserving item ids and dereferencing a shared-in
  source; skills route through the `SkillManager` (discovered loosely) so the copy is indexed into the
  KnowledgeIndex, falling back to a structural document copy when skills isn't loaded. `share`, `unshare`
  and `copy` accept `id: '*'` for a whole namespace, and `owner` with `'*'` returns an owners map so a UI
  can gate a list in one round-trip instead of one call per item. Share/copy failures now name the
  intersection of the two profiles' isolated namespaces instead of claiming the target "already reads the
  shared base data".

- **storage/profiles + frontend/web: a shared item stays live.** An owner's edit to a shared file now
  reaches every sharee's event stream: the shared-in set is seeded at open (scanning each partition's file
  area for `.meta.json` symlinks) and feeds both the write-guard and the watch's visibility clause.

- **frontend/web: read-only shared files are legible in the Workspace list.** A file opens as raw bytes in
  a new tab — a surface that can carry no banner — so the row carries the state: a file shared in from
  another profile is tinted and stripe-marked and shows an always-visible line naming the owner ("shared
  by …" / "shared globally") and its read-only status, with the share button withheld and delete
  relabelled. The file list stays profile-agnostic; ownership comes from one `owner`/`*` call. The sidebar
  panel is now titled "Workspace".

- **frontend/web + frontend/dom: `url_for_resource` drops its `namespace` parameter.** The parameter asked
  for a file's *content* namespace (`"workspace"`) while the `share` tool's identically-named parameter
  takes a storage *isolation axis* (`"files"`) — one name, two levels, contradictory values for the same
  file, so a model that had learned one binding generalised it to the other and produced calls that could
  not resolve. The tool now takes `{ name }`, resolves the file by the path it was stored under, and
  sources the route's namespace segment from the stored handle; minted URLs are unchanged. A file with no
  stored namespace reports as not viewable rather than minting a URL that would 404.

- **tools/bash: the legacy in-tool docker executor is removed.** `createBashTool(docker?)` had no caller,
  so the branch was unreachable — and strictly worse than `docker-bash`, which owns the sandboxed
  implementation (same tool name and input shape, plus a persistent container, read-only project root, an
  output byte cap and a `bash_config` tool). `DockerConfig` and `createBashTool` are gone; `bashTool` is a
  plain constant. The tool description, the `cwd` schema and the README no longer describe the working
  directory as "the session workspace": it is a private scratch area for temporary scripts and
  intermediate data, and nothing written there is visible to the user, servable, or shareable.

- **tools/workspace: the tool describes itself as matbot's cloud file storage.** The description now
  frames the store as the user's own files in a managed cloud drive (not the local disk) backing the
  Workspace panel, and directs the model here — rather than to bash — whenever the user speaks of a file,
  saving output, uploads, downloads or generated artifacts.

- **providers/chatjimmy: published.** The ChatJimmy adapter is no longer `private` — it publishes as
  `@matatbread/matbot-provider-chatjimmy`, is a dependency of the CLI, appears in the first-run setup
  wizard's provider list, and resolves by bare package name from an installed matbot as well as a source
  checkout. A hosted llama endpoint: keyless, non-streaming, text-only and no tool-calling — useful as a
  low-latency comparison point rather than a general-purpose provider.

## 0.3.4

_User profiles, profile-specific backend correctness, and cross-profile resource sharing._

### Breaking changes

- **`Subscribable`/`Broadcaster` now wraps every event in a `Routed<T>` envelope** carrying an optional
  `origin` principal — the partition or actor that produced it. `subscribe()` yields `Routed<T>` instead
  of bare `T`; `emit()` takes an optional `origin`; `consume()` handlers receive `Routed<T>`. Both
  `subscribe()` and `consume()` accept an optional `RoutedFilter` for per-subscriber origin filtering.
  Core's internal watchers (`watchPlugins`, `ToolRegistryImpl.watch()`) unwrap the envelope; any
  third-party subscriber must do the same (`for await (const { value } of …)`).

- **`Mounted.consume()` renamed to `Mounted.observe()`.** The method name changed so `consume` means
  exactly one thing repo-wide (the detached `Subscribable` stream drain); signature and semantics are
  identical. Every plugin that subscribes to a service (re)mount needs a one-word update.

- **`Session` ownership fields removed.** `Session.ownerPrincipalId`, `actorPrincipalId`, and `persona`
  are removed from the interface. `RunConfig.persona` is removed. `CreateSessionOpts` no longer takes
  `ownerPrincipal`/`actorPrincipal`/`persona` — `createSession()` now takes no required arguments.
  These fields were never read: ownership-at-rest is structural (the storage partition), not a stored
  field. Old persisted data keeps them harmlessly as excess properties.

### API gaps filled

- **Branded `ReadOnlyError` for store writes rejected by principal ownership.** `readOnlyError()` factory
  and `isReadOnlyError()` guard (brand-based, never `instanceof`) let a `Store` reject a write when the
  current principal does not own the item — e.g. a session shared read-only from another profile's
  partition. The turn pump catches it around the persist-at-turn-start write in `SessionRunner`: a
  read-only rejection is surfaced as a per-turn `error` event and the submission is dropped, instead of
  escaping the detached pump and crashing the host.

- **`CachingStorageBackend` — read-through, write-through cache decorator**
  (`@matatbread/matbot-core/storage-base`). Wraps any `StorageBackend` in a per-namespace,
  cache-aside, write-through cache: reads serve from a full in-memory image warmed lazily, while
  `set`/`cas`/`delete` go to the backing store first and then update the image. Cross-platform (pure
  logic, no Node primitives). Compose it below any principal-partitioning router so each partition gets
  its own cache.

- **Storage consumers now read through the store proxy instead of keeping an in-memory snapshot.**
  `TriggerManager` and `SkillManager` each held a `Map` loaded once at boot — making reads
  principal-blind (a profile isolating `triggers`/`skills` still saw the base partition's data) and
  stale under any second writer. Both now read straight through the store proxy, which follows both the
  live backend and the current principal's partition.

- **`WatchVisibility` — partition-aware file-watch layer (new optional service).** Registered by a
  partitioning storage backend, consumed by frontend firehoses. The generic
  `visible(viewer, namespace, origin)` predicate — `route(viewer, ns) === route(origin, ns)` — is
  correct for files, skills, and any future namespace uniformly: a viewer sees global/base events for
  namespaces it does NOT isolate, and only its own partition's events for namespaces it does.

### Bug fixes

- **`FilesystemFileStore.watch()` no longer throws `ENOENT` on a missing directory.** It now ensures
  the directory first (mirroring `put()`/`list()`), so a registered `StorageBackend` acting as the
  boot backend no longer crashes the web frontend at startup on a fresh data directory.

- **Forward `thinking`/`reasoning` parameters to the provider API and preserve reasoning blocks on
  tool-call replay.** Previously these parameters were dropped, so a provider configured with thinking
  enabled silently fell back to the default.

### Optional

- **Storage profiles — per-principal storage partitions, profile-aware file routing, hot-add, and
  item-grain sharing.** A new `storage-profiles` plugin partitions every store + file area by
  principal. Profiles can be created and switched to at runtime — no restart. File storage is
  profile-aware (`put`/`get`/`list`/`delete`/`watch` all route to the current principal's partition),
  and served file URLs bake the principal into the path. Items (e.g. a session) can be shared
  between profiles via symlink (live single source, not a copy), with `share`/`unshare`/`owner`
  actions. A shared-in session is surfaced as read-only, enforced by `ReadOnlyError` at the store
  level. The `profile` tool is renamed `profile_action` for consistency. **This plugin demonstrates how a user-specific frontend could be implemented**, although it has no auth/login of its own (the frontend/web UI simply allows you to create new, named profiles).

- **Skills watch fan-out with dynamic partitions.** `SkillManager.watch()` now yields origin-stamped
  events (`Routed<SkillEvent>`), and the web firehose filters `skill-changed` per connection. A
  profile that isolates `skills` sees only its own skill CRUD; a profile created mid-session is
  watched without a restart.

- **Web frontend — profile-aware identity, file URLs, and session sharing.** An `x-matbot-principal`
  request header overrides per-request identity. A profile selector appears in the header (hidden
  when no `profile` tool is registered). Served file URLs bake the principal into the path so a plain
  browser GET works. A share button on the chat header lets the user share the open session into
  another profile that isolates `sessions`; shared-in sessions show a "read-only · &lt;owner&gt;" badge
  and hide the share button. The composer is disabled for read-only sessions.

- **Web-bundle — provider profiles resolve by package name, not a build-specific `mbmod:` id.**
  Adapter package names are added to the import map, and the wizard offers/persists the package name.
  Boot self-heals older saved configs — a still-known synthetic id is repaired to its package name.

## 0.3.3

### Breaking changes

- **`MatbotRuntime` gains a required `TypeScriptStripper` member.** Type-stripping is now a first-class,
  always-present host capability rather than something each consumer reinvents: `services.TypeScriptStripper
  .strip(source)` erases TypeScript types from a source string and returns runnable JS (may be async). It is
  provided per platform by the host — `apps/cli` wires node's built-in `stripTypeScriptTypes` (erasable-only),
  `apps/web-bundle` lazy-loads sucrase on first use — and is *not* a registry/swap key (it lives on the fixed
  runtime, not `MatbotServices`). Impact: anyone who *constructs* a `MatbotMachine` (a custom host or test
  harness) must now supply a `TypeScriptStripper`; a plugin that merely reads services is unaffected. Consumers
  that compile source at runtime should call `services.TypeScriptStripper` instead of importing a
  platform-specific stripper (this is what makes `function-tools` cross-platform with no stripper of its own).

- **`MatbotRuntime.providers` is now a `ProviderRegistry`, not a `ReadonlyMap`.** *Reading is
  source-compatible* — `ProviderRegistry extends ReadonlyMap<string, ProviderConfig>`, so every existing
  consumer (`services.providers.get`/`has`/`keys`/`values`/iteration) is untouched; a plugin that only
  reads `services.providers` needs **no change**. Two things can bite:
  1. **Anyone who *constructs* a `MatbotMachine`** (a custom host, a test harness) must now supply a
     `ProviderRegistry` for the `providers` member — a bare `Map`/`ReadonlyMap` no longer satisfies it, as
     it lacks `register`/`remove`/`revert`. Use the new `ProviderRegistryImpl` (exported from
     `@matatbread/matbot-core`).
  2. **Profile `module` values are no longer canonicalised to the plugin name.** Previously the host
     rewrote each profile's `module` to the loaded adapter plugin's canonical name at boot; now the stored
     `module` is left exactly as configured (a yaml path stays a yaml path). So `services.providers.get(x)
     .module` returns the source specifier, not the resolved plugin name — code that relied on the
     canonical name must map it with `getPluginNameForSpecifier(module)`. Resolution itself is unaffected:
     `instantiateProvider` accepts either form.

- **`MatbotServices` split into a registry bucket + `MatbotRuntime`, joined as `MatbotMachine`.** What a
  plugin's `setup(services)` receives is now `MatbotMachine` (the full object). `MatbotServices` itself
  shrank to only the *registerable* services — `StorageBackend?`, `Vault`, `KnowledgeIndex`, plus
  whatever plugins augment in — making it the precise `keyof` domain of `register`/`get`, so
  `register('hooks', …)` (registering a runtime handle that was never swappable) is now a compile error.
  The fixed plumbing (hooks, tools, complete, settings, sessions, createStore, and the registry API
  itself) moved to the new `MatbotRuntime`. Migration is mechanical and the *public* surface is
  unchanged: the `register`/`get` signatures still read `keyof MatbotServices` (now correctly scoped),
  and the `declare module '@matatbread/matbot-plugin-api' { interface MatbotServices { … } }`
  augmentation idiom is untouched — only annotations of the *full* services object move `MatbotServices`
  → `MatbotMachine`. A plugin that relies on `setup`'s inferred parameter type needs no change.

- **`vault`/`Vault` collapsed to a single member.** The lowercase `services.vault` read accessor is
  removed; the vault is now both read and registered through one `services.Vault` member (non-optional,
  capture-safe proxy), consistent with `KnowledgeIndex`/`StorageBackend` — the previously write-only
  `Vault` register key is now also the read surface. Migration: `services.vault` → `services.Vault`. The
  tool-context field `ctx.vault` is a separate surface and is unchanged.

### API gaps filled

- **`CachingStorageBackend` — read-through cache decorator (`@matatbread/matbot-core/storage-base`).**
  Wraps any `StorageBackend` in a per-namespace, cache-aside, **write-through** cache: reads serve from
  a full in-memory image of the namespace (warmed lazily by one `backing.query({})`), while every
  `set`/`cas`/`delete` goes to the backing store first (system of record — CAS and durability unchanged)
  and then updates the image. Coherence is honest: always coherent with the wrapper's own writes; foreign
  writes only as sharp as the optional `ttlMs` tier (a bounded-staleness ceiling — unset ⇒ warm once,
  never expire). Cross-platform (pure logic + `Map` + `executeQuery`, no Node primitives). Compose it
  *below* any principal-partitioning router so each partition gets its own cache. Purpose: stop slow
  backends re-reading whole namespaces every turn; the correctness half (consumer-side caches → read-
  through) shipped earlier this release. A `stats()` method exposes per-namespace counters
  (`CacheNamespaceStats`: docs / reads / hits / loads / lastLoadMs) for confirming the cache is serving
  reads rather than re-reading the backend.

- **Augmentable per-tool-call round-trip metadata (`ProviderMeta` + `tool-call` `meta?`).** The
  `tool-call` variant of both `CompletionEvent` and `MessageContent` gains an optional `meta?:
  ProviderMeta` — opaque, provider-specific round-trip state captured from a completion and re-sent
  verbatim when the call is replayed in history. `ProviderMeta` is an empty, augmentable interface (same
  idiom as `MatbotServices`/`MarkerData`/`ToolContracts`): a provider package declares its OWN slice
  from its own module (namespaced by provider family, e.g. `interface ProviderMeta { google?: {
  thoughtSignature?: string } }`), so adding a provider that needs round-trip state touches **no** core
  code. It's an open, additive union (interface augmentation), not a generic parameter, because a single
  session interleaves tool-calls from many providers. The runner persists `meta` on the stored
  `tool-call` and threads it back through `pendingCalls`, never interpreting it — so a provider that
  requires such a token (Gemini 3 "thought signatures", mandatory on every historical `functionCall`)
  round-trips its own history losslessly, while any adapter is free to elide a call whose `meta` it
  doesn't trust when rendering cross-provider history.

- **`ToolProxy` gains a trailing catch-all overload per tool (params union → result union).** A bare
  overload set is precise at call sites but unsound at the meta-type level: `ReturnType<typeof tool.x>`
  resolved to whichever arm happened to be declared last — a real-world codegen trap (a model
  pre-declaring a result variable that way produced a baffling TS2739 it could not repair in three
  passes). Call sites are unchanged (overload resolution is first-match, so well-formed calls still
  narrow to their arm and malformed calls still error — with *better* messages, since the "last
  overload" tsc reports against is now the full params union, which enumerates the valid actions and
  triggers "Did you mean…" suggestions). Two things become expressible: `ReturnType` degrades to the
  sound result union instead of an arbitrary arm, and a params value typed as a union of arms (dynamic
  multi-action dispatch) is now callable, returning the result union.

- **Plugin load failures are recorded, not swallowed (`getFailedPlugins`).** A plugin the loader skips —
  an incompatible `matbotRuntime`, an import that rejects, a module that isn't plugin-shaped, or a `setup()`
  that throws — still fails *gracefully* (the boot batch skips it and continues; only an explicit single load
  throws), but no longer *silently*. The loader records `{ specifier, name?, error }` on the registry at each
  skip point; a subsequent successful (re)load of the same specifier clears its entry. New core accessors:
  `getFailedPlugins()`, `recordFailedPlugin(entry)`, `clearFailedPlugin(specifier)`. The `plugin` tool's
  `list` result gains an optional `failed` array, and the web plugins panel renders the failed set (with the
  reason and retry/remove actions) so a mis-configured plugin is visible instead of vanishing into a console line.

- **`Tool.toolContract` — the call contract as TypeScript text, for tools with no scannable source.** A tool
  whose name and/or shape are built at runtime (a `function-tools` function; the `tool-store` per-namespace
  CRUD tool) can't carry a static `ToolContracts` augmentation, so it declares its contract as a single
  `toolContract` string on the `Tool` — identical in shape to an augmentation arm (`'ToolContract<Result,
  Args>'`, or a `|`-union of arms). `ToolTypeIndex` splices it into the generated dts's `ToolContracts` (bare
  `ToolContract` rewritten to an inline `import(...)` for self-containment) and derives the wire text from it,
  exactly as it does a source tool's arms. `function-tools` populates it from each defined function's
  signature (`ToolContract<return, { …params }>`). A tool WITH source declares an augmentation instead and omits
  this; a foreign tool (MCP proxy) with neither keeps only its loose `inputSchema`. The wire `params`/`result`
  text is no longer authored on the `Tool` (the retired `paramsType`/`resultType`) nor rendered by a
  `toolWireDescription` helper — it is derived from the one contract and folded into the tool description at
  the dispatch edge (see below).

- **`MatbotServices.ToolPresenter` (optional) — per-call tool advertisement.** A plugin may register a
  `ToolPresenter` whose `present(tools, { session, provider })` chooses which tools are advertised to the model
  on each provider call. The runner consults it before *every* call, so a presenter may advertise a subset
  (deferring a large library behind a search tool) and grow it mid-turn as the model discovers tools. Absent ⇒
  the whole turn snapshot is advertised, byte-identical to before. Presentation is orthogonal to the
  `ToolRegistry`: a withheld tool still resolves by name at execution, so this only changes what the model is
  *told about*, never what it can call.

- **`MatbotServices.ToolTypeIndex` (optional, node-only).** A new registerable service for typing what
  tool calls resolve to: `dts()` returns a self-contained `.d.ts` of the loaded tools' result/service types —
  the source-derived augmentations (from compiling each plugin's `declare module` block) merged with the
  `toolContract` string a source-less tool declares on itself, read off the live registry, for tools
  the source scan can't reach (a `function-tools` function; a name already covered by the source scan is
  skipped so it isn't declared twice). The scan is driven off the **loaded plugins' `resolvedUrl`s** — the
  real source each tool was loaded from, so builtin, compiled, and installed plugins are covered uniformly —
  unioned with a monorepo `plugins/` glob that catches app-embedded builtins (`plugin`/`provider`) which are
  constructed by the host and so carry no `resolvedUrl`; in a real deployment there is no `plugins/` tree, so
  the scan is purely `resolvedUrl`-driven. `dts()` declares the
  injected proxy as `declare const tool: ToolProxy` — the new `ToolProxy` mapped type turns each tool's
  `ToolContracts` arms into call-signature **overloads**, so `await tool.name(params)` narrows its result by
  the params passed. `check(snippet)` grades the snippet against exactly that `dts()` (what a generator is
  shown ≡ what it is graded against), returning snippet-scoped diagnostics. `wireContracts()` returns each
  source-scanned tool's flat `params`/`result` text flattened back from its arms. Lets tool-call code
  generators/composers type — and verify — what `tool.x()` returns and how to call it instead of guessing.
  Optional and absent where no TypeScript program can run (the browser today), so consumers must degrade.
  Provided by the new `tool-types` plugin.

- **The `ToolContracts` augmentation is the single contract source for every source tool; `paramsType`/
  `resultType` are retired.** Each `ToolContract<Result, Params>` arm carries the **full** params for that
  action (the discriminant lives *inside* the params, not as a separate pattern), so one authored declaration
  drives everything: the executor binding (`ToolExecutor<ToolResultOf<'name'>>`), `invokeTool`/`toolResult`
  narrowing (`ToolResultFor`), the overloaded `tool` proxy (`ToolProxy`, above), and the flat wire
  `params`/`result` text — derived from the arms by `ToolTypeIndex.wireContracts()` and folded into the
  outgoing tool descriptions at the turn's dispatch edge (`session-runner`, wired via the new optional
  `SessionRunnerDeps.toolTypeIndex`). This holds for **single-action tools too**: each declares one arm
  (`name: ToolContract<Result, Params>`), never a bare `name: Result` — the bare form yields no callable
  `ToolProxy` signature. Tools with no scannable source carry a `toolContract` string instead (above); the
  `Tool.paramsType`/`resultType` fields are gone entirely. Motivated by a model probe: an overloaded proxy
  generates reliable tool-call code first-try across model tiers where the earlier single-signature/union
  proxy was model-fragile and could even produce a silently-broken tool that still type-checked.

- **Removing a vault secret.** `Vault.writeSecret(name, '')` now removes the key rather than storing an
  empty value — there is no meaningful empty secret, so the empty string is the removal signal (idempotent
  across `VaultImpl`, `EnvFileVault`, `WebCryptoVault`, `LocalStorageVault`, `DriveVault`). No new interface
  method or tool action: the LLM removes a secret through the existing `plugin` `store-key` action by
  leaving the out-of-band value prompt blank.

- **Contributing provider profiles live** (see also the `MatbotRuntime.providers` contract change under
  Breaking changes). The registry adds `register(config)`/`remove(name)`/`revert(name)`, so a plugin can
  now contribute named provider profiles — the sibling of contributing tools via `ToolRegistry` — letting a
  storage backend replay provider definitions from its own medium, not just plugins. `revert(name)` restores
  the boot profile (or deletes if there was none), so a contributed — possibly shadowing — profile is undone
  on unload; `remove` stays a true delete. New core exports: `ProviderRegistryImpl`,
  `tryResolveProviderFactory(module)` (non-throwing lookup), and `instantiateProvider(services, config)` —
  config → adapter that force-loads the adapter module on demand (warning and returning `null` rather than
  throwing if it can't be found), so a profile whose adapter plugin isn't loaded yet resolves itself on first
  use instead of aborting the turn (removing the need for the boot-time provider pre-scan). The reusable
  browser provider tool (`createBrowserProviderTool` + `ProviderAdmin`) moved to `@matatbread/matbot-browser`
  so a storage-backend plugin can back the same tool with its own persistence.

- **`KnowledgeIndex.remove(id)`.** The index gained a retraction primitive — idempotent, keyed by the
  entry `id` (the index's sole primary key, the same key `index` replaces on). The index stays
  source-blind: it never inspects an entry's opaque `source` to decide visibility; the party that
  indexed an entry owns retracting it. Implemented by both backends (`LookupKnowledgeIndex`,
  `persist-ki-bge`) and forwarded transparently by the swap proxy. Breaking only for a third-party
  `KnowledgeIndex` implementation, which must now provide `remove`.

- **`MatbotPlugin.resolvedUrl`.** The loader now retains the stable URL it actually imported (minus any
  reload cache-bust stamp) on each loaded plugin, instead of computing and discarding it. This lets a
  consumer map a loaded plugin back to its on-disk source without re-running specifier resolution — used
  by `skills_compiler` to build a types program over the live plugin set. Optional (absent only on hosts
  that hand-construct `MatbotPlugin`); the `plugin` tool's `list` reports it.

- **Typed tool results: `ToolContracts` registry + `toolResult` reader.** A tool's result type is now
  recoverable at the call site. `ToolContracts` is an augmentable interface (same pattern as `MarkerData`)
  mapping a tool's `name` → the type of the `value` it yields; `invokeTool` is generic over the name, so
  `invokeTool(machine, 'find_fact', …)` is typed `AsyncIterable<ToolEvent<string[] | null>>`. The new
  `toolResult(events)` drains the stream to that typed `result` value (the structured counterpart to
  `toolText`, which collapses to a string). Unregistered tool names resolve to `unknown`, forcing the
  caller to narrow. `ToolContracts`, `ToolResultOf`, and `toolResult` are exported from
  `@matatbread/matbot-plugin-api`; `ask-user` and `rumsfeld` register their tools' result types.

- **`ToolExecutor<R = unknown>` / `Tool<R = unknown>` carry the result type at the source.** The
  producer side is now typed too: `ToolExecutor.execute` returns `AsyncIterable<ToolEvent<R>>`, so a
  tool declares the type of the `value` it yields once, where it's written. Binding the executor to its
  registry entry — `ToolExecutor<ToolResultOf<'my_tool'>>` (or `Tool<ToolResultOf<'my_tool'>>` on the
  tool object) — makes the `ToolContracts` augmentation the single source of truth: the executor's yields
  and the registry entry can no longer silently drift, since the compiler checks the yields against it.
  The `unknown` default keeps every untyped executor compiling untouched, and covariance means a
  narrower `ToolExecutor<X>` still satisfies the heterogeneous `Tool[]` registry boundary. Most built-in
  tools with a well-defined structured result now declare it (`whoami`, `session_action`, `session_edit`,
  `compact_sessions`, `bash`, `bash_config`, `workspace_action`, `dream_time`, `ask_inner_voice`,
  `cognition_config`, `skill_action`, `skills_config`, `trigger_action`, `triggers_config`, `provider`,
  `plugin`, `mcp_action`, `store_action`, `background`, `every_action`, `single_turn`, the `url_for_resource`
  / telegram tools); tools whose result is genuinely `unknown` (`http`, the MCP proxy, the runtime-named
  store tool) keep the default and remain unregistered, forcing the caller to narrow.

- **Per-call result discrimination for multi-action tools (`ToolContract<Result, Args>`).** A multi-action
  tool is a weird overloaded function — it returns different shapes depending on its params. Its
  `ToolContracts` entry can now be a union of `ToolContract<Result, Args>` *arms*, each pairing a result with
  the discriminating params *pattern* that selects it; `invokeTool` is generic over the params (`const P`)
  and narrows the result to the matching arm. `invokeTool(machine, 'session_action', { action: 'get', … })`
  is now typed to yield `Session`, not the union of every action's result. The discriminant is *any*
  field(s), not just `action` (e.g. `background` keys on `interval`'s presence: `ToolContract<…, { interval:
  string }>`); the pattern is the discriminant only, not the full input, so a call carrying just that field
  still matches. When no arm matches (a non-literal discriminant, or an absence-discriminant the positive
  patterns can't express) the result falls back to the union of all arms — always sound, just less narrow.
  `ToolResultOf<K>` unwraps an arm-based entry to that union, so executors still bind unchanged
  (`ToolExecutor<ToolResultOf<'my_tool'>>` must cover every arm). `ToolContract` and `ToolResultFor` are
  exported from `@matatbread/matbot-plugin-api`. Every built-in multi-action tool adopts the arm form:
  `session_action`, `session_edit`, `workspace_action`, `background`, `every_action`, `skill_action`,
  `skills_config`, `cognition_config`, `trigger_action`, `triggers_config`, `provider`, `plugin`,
  `mcp_action`, `store_action`, and `bash_config`. Behaviour is unchanged — type-level only.

- **`invokeTool` opts are now a named `InvokeToolOptions` type derived from `ToolContext`.** A tool
  forwarding a call to another tool can pass its own `ctx` straight through as the 4th argument —
  `session`, `signal`, `prompt` and crucially `provider` all propagate, so a callee that needs an LLM
  (e.g. `find_fact`, or anything using `singleTurn`) inherits the turn's provider instead of failing
  with "no provider". Previously the opts were an inline literal type, which invited callers to
  hand-pick `{ session, signal }` and silently drop `provider`. Runtime behaviour is unchanged (the
  function always threaded `opts.provider`); this makes the correct, complete forwarding the obvious
  typed path. `InvokeToolOptions` is exported from `@matatbread/matbot-plugin-api`.

- **Tool `progress` events now reach frontends.** A tool's `{ type: 'progress', pct, message? }`
  `ToolEvent` was matched and dropped by the runner — the only `ToolEvent` variant that went nowhere.
  The runner now forwards it as a new `tool:progress` `PipelineEvent` (`{ callId, pct, message?,
  traceId }`), so it streams to every frontend like `tool:stdout`. The CLI prints `[pct%] message`;
  the web frontend inverts the leading `pct`% of the tool block as a left→right wipe (cleared on
  `tool:end`). Producers that already emitted progress (`edit-session` compaction, `skills_compiler`)
  now surface it with no change.

- **`invokeTool`/`toolText` — call a tool by name programmatically.** Two helpers exported from
  `@matatbread/matbot-plugin-api` formalise the resolve-then-drain pattern that callers (the triggers
  dispatcher) were hand-rolling. `invokeTool(machine, name, params, opts)` resolves the tool off
  `machine.tools` (throws if unregistered), builds a full `ToolContext` from the machine (vault, plugin
  load/unload, workdir/configPath/files), and returns its `AsyncIterable<ToolEvent>`; the caller
  supplies only the host-bound bits via `opts` (`session`, `signal`, optional `prompt`/`provider`/
  `callId`) — no `prompt` runs non-interactively (a prompt attempt rejects as a normal tool error).
  `toolText(events)` drains that stream to its result string (throws on the first `error` event or if
  no `result` was yielded), rendering as the model would see it (string verbatim, `{ content: string }`
  by `content`, else JSON).

- **Token/cost usage is now persisted on the session.** Two new fields carry per-call accounting that
  was previously emitted live and dropped: `Message.usage?: Usage` records the provider call that
  produced an assistant turn (billed provider is the message's `providerName`), and a `tool-result`
  block gains `usage?: UsageRecord[]` for completions a tool runs itself (`single_turn`,
  `ask_inner_voice`, each of `dream_time`'s ranker/merger calls), one provider-tagged entry per call.
  Both are pure accounting — elided from provider submission (adapters serialise only
  `id`/`result`/`isError`), so they never reach the model. Capture is automatic via a new ambient
  **usage carrier** (`installUsageCarrier`/`recordUsage`/`currentUsageSink`/`withUsageScope`,
  mirroring the principal carrier; node ALS-backed, browser serial): a tool reaches an LLM only
  through `complete`/`singleTurn`, so reporting at that one choke point attributes every tool's spend
  to its call with zero per-tool code. `single_turn`/`ask_inner_voice` no longer return usage in their
  result (it was leaking accounting data to the model). `CompletionResponse.usage` widened from
  `{ inputTokens, outputTokens }` to the full `Usage` (adds optional `costUsd`, cache token counts).
  A session's total cost is now computable from its stored messages (an aggregation tool is a follow-up).

- **`screen` hooks can now inject *durable* context, the persisted twin of `ephemeral`.** A new
  `ScreenResult.durable?: MessageContent[]`: where `ephemeral` informs only the turn about to run,
  `durable` is folded onto that turn's user message (the runner appends the blocks to the last
  `role: 'user'` message, so they persist into history and ride every subsequent provider call) AND
  carried live on the turn's event stream as the previously-unused `robo-user` event — so a live draw
  and a reload render the same thing. Callers mark the blocks `origin: 'robo'` so frontends present
  them agent-side (the web `appendUserTurn` already splits a user turn's robo blocks into their own
  bubble; the live `robo-user` handler now draws that same bubble, and the CLI labels the content
  `[context]` rather than `you:`). Lets a `screen` hook produce context that genuinely updates the
  conversation, not just a one-shot corrective.

- **`followup` hooks can now `retractAndRerun` a committed turn.** A new
  `FollowupResult.retractAndRerun?: { context }` capability alongside the existing
  `resubmit`: instead of appending a robo turn *after* the response, the pump pops the
  just-committed turn back to (and excluding) the last user message into a durable
  retraction marker (creator `matbot-retraction`; `data.retracted` holds the popped
  messages and `data.injected` the ephemeral context fed to the redo — the pair fully
  traces the swap for a strike-through render and post-mortem, LLM-elided like any marker),
  then re-runs that same user turn with `context` injected ephemerally. Filled by:
  `runFollowup` collecting a merged `retract`; a `redo?: { ephemeral }` field on the
  pump's queue item that skips the persist-at-turn-start user append and forwards the
  context to `runSession` via a new `RunSessionOpts.injectedEphemeral` (merged ahead of
  `screen`'s ephemeral, sharing the identical tail-fold path). `resubmitDepth` caps a
  non-self-terminating chain. Also fixed: ephemeral now tail-folds onto the last
  *non-marker* message, so a trailing marker (e.g. the retraction marker) doesn't
  swallow the injected context.

- **Registry observation: `ToolRegistry.watch()` and `watchPlugins()`.** Two read-only
  `AsyncIterable` streams over registry CRUD — `ToolRegistry.watch(signal?)` yielding
  `ToolRegistryEvent` (`registered`/`removed`, one per tool — `removeByPlugin` emits per match)
  and the module-level `watchPlugins(signal?)` yielding `PluginRegistryEvent`
  (`loaded`/`unloaded`) — both fed by one shared multi-subscriber broadcaster. Read-only:
  observers can't veto a registration (interception is a separate, deliberately unbuilt concern).
  Lets consumers react to a registry changing *out of band* — e.g. a storage backend restoring a
  plugin set during its own `setup()`, after a frontend's one-shot load. `watch()` is a **required**
  `ToolRegistry` method (breaking for any external implementer): the two host bootstraps that
  hand-rolled their own registry literal were consolidated onto the exported `ToolRegistryImpl`,
  which now emits on register/remove/removeByPlugin and takes an optional seed-tools constructor.

- **`services.mounted` — a keyed mount table for reacting to a registry service (re)mounting or
  unloading.** `MatbotRuntime.mounted: Mounted` exposes one method,
  `consume({ key, replay?, signal?, onUnmount? }, handler)`, keyed on the `MatbotServices` interface a
  plugin depends on. The host batches notifications to the quiescent edge and **multicasts** each key's
  net presence transition to that key's subscribers: a reload (unregister+register before the edge)
  collapses to a single **remount**; an unregister not replaced by the edge is a **committed unload**,
  delivered to `onUnmount`. The handler receives the (per-plugin scoped) machine with `key` narrowed
  present (`MountedMachine<K>`). `replay: true` is the deferred-dependency latch — fire on the next
  microtask against the current machine if the key is present now, then on each remount (so a consumer
  whose dependency may load *after* it is seeded with no resident poll-hook). The contract guarantees
  only eventual, ordered delivery per key — **timing is unspecified** (a register is not observably
  inline nor pinned to a turn boundary). `StorageBackend`'s deferred swap still lands at the edge; other
  keys repoint immediately but notify at the edge. Use it only when `setup()` reads another service's
  current state to build cached/derived state; a pure map resolves its dependency per-invocation and
  subscribes to nothing. (`createMountTable` is the shared host helper; the `Subscribable`/`Broadcaster`
  broadcaster split it was prototyped on stays for the `watch` streams.)

- **`contextSwitch` / `onContextQuiesce` — quiescent-edge machine flush, layered over the principal
  carrier.** `contextSwitch(principal, fn)` runs `fn` under `principal` (like `runAs`) and additionally
  runs host-registered flushers (`onContextQuiesce(flush)`) whenever no scope is active (depth 0). The
  principal carrier stays a pure identity primitive; this is the host's hook to *land deferred machine
  mutations* — currently the `StorageBackend` swap — at a boundary where no turn is mid-flight. The pump
  turn now switches context; web/telegram entry points stay `runAs` (their scope spans a long-lived SSE
  stream, so they must not register as a busy edge). Re-exported from `@matatbread/matbot-core`.

- **`NotAPluginError` — a typed "this module is a library, not a plugin" load failure.** The loader's
  three shape checks (no `plugin` export, a `plugin` without `apiVersion`, a non-function lifecycle
  member) now throw this instead of a bare `Error`, carrying the `specifier` and the precise `reason`.
  It is the post-import sibling of `IncompatibleRuntimeError`: both mean *permanent for this specifier*,
  letting the `plugin add` flow roll the entry back out of config rather than persisting something that
  can never activate. Import-rejection failures (a bad path, a syntax error) stay a plain `Error` — they
  may be a fixable typo. Exported from `@matatbread/matbot-plugin-api` and re-exported from
  `@matatbread/matbot-core`.

### Bug fixes

- **A store query with an unknown top-level key is now rejected instead of silently matching
  everything.** `validateQuery` only checked the values inside `where`/`sort`/`limit`, and
  `executeQuery` validated the *projected* query — which keeps only those three keys — so a clause
  placed under any other key (e.g. `{ filter: { … } }`, an SQL-ism LLMs reach for despite the grammar
  in every tool-store description) was dropped before validation ran. The query degraded to
  match-everything and the author got a plausible full result with no error. `validateQuery` now
  rejects a non-object query and any unknown top-level key (`MALFORMED`, naming the bad key and the
  valid set: `where`, `sort`, `limit`, `cursor`), and `executeQuery` validates the caller's raw query
  before projecting it (a decoded cursor is still validated as before). The generated `tool-store`
  CRUD tools catch the resulting `StoreQueryError` and frame it for the model, pointing back at the
  `query` grammar in the tool's own description.

- **Deleting a skill no longer orphans its knowledge-index entry.** `skill_action(delete)` removed the
  skill from its store but never retracted the `KnowledgeIndex` entry, so the deleted skill stayed
  discoverable by `contextual_search` / `find_fact` indefinitely (durably so under the persistent
  `persist-ki-bge` backend; until restart under the in-memory default). `delete` now also calls
  `KnowledgeIndex.remove`, closing the leak in both backends.

- **`LookupKnowledgeIndex` (the default in-memory index) now scores against curated metadata, not just
  raw content.** It previously counted query-term occurrences in `entry.content` alone — ignoring the
  LLM-derived `entities`, `tags`, and `summary` entirely — so a long, wordy entry could out-score a
  short one whose curated entities named the term outright. Search now weights an exact entity match
  highest, then fuzzy-entity / tags / summary / content headings, with raw body occurrences saturated
  (`tf/(tf+k)`) to remove the length bias. Free-text matching is word-boundary (so "matt" no longer
  matches "matter", "owl" not "fowl"); curated entity/tag matching stays fuzzy-substring (so "matt"
  still finds the entity "Matthew Woolf"). The returned window also guarantees a few alternatives
  (min 3, max 10) rather than only the single coverage winner. (The reranking `persist-ki-bge` backend
  already used metadata; this brings the zero-config default in line.)

- **`session.updatedAt` now tracks conversational activity, not structural/metadata edits.** It is the
  timestamp of the session's last message (its `createdAt`), or the session's own `createdAt` when empty —
  a materialised field upholding a single invariant (new helper `lastActivityAt(session)`), not a fresh
  `now()` stamped at each write. Previously `session_edit` (`compact`/`cut`/`split`), `fork`, and
  `session` `rename`/`hide` each stamped `now()`, so compacting or renaming a session floated it to the
  top of a recency-sorted list despite no new conversation. All session writers now derive `updatedAt`
  from the final message via `lastActivityAt`; `appendMessage` uses the appended message's `createdAt`.
  Kept as a stored field (not a getter): `Session` round-trips as plain JSON and is sorted on `updatedAt`
  as a stored column.

- **A bad `matbot.yaml` plugin entry no longer aborts startup.** `loadPlugins` only honoured its
  `skip`/`throw` mode (renamed `onIncompatibleRuntime` → `onLoadError`) for the runtime-compat gate;
  an import that rejected or a module that was not plugin-shaped (no `plugin` export, no `apiVersion`,
  a non-function lifecycle member) threw unconditionally — out of the startup batch, exiting the
  process. Under a supervisor that restarts on exit (e.g. systemd `Restart=always`), a single
  mistaken entry — a bare library mistaken for a plugin (a module that imports cleanly but exports no
  `plugin`) — became an unbreakable crash loop fixable only by hand-editing the config. The startup
  batch now logs and skips every such failure; only an explicit, user-initiated load (the
  `plugin`/`provider` tools, which pass `throw`) still surfaces the error. Regression-tested in
  `apps/cli` (`pnpm test`).

- **Unloading a plugin that provided a swap-key core service no longer leaves a dangling reference.**
  `services.unregister` is now symmetric with `register` for the three swap-members (`StorageBackend`,
  `Vault`, `KnowledgeIndex`): when the providing plugin is unloaded, the member **reverts to the host's
  captured boot default** (and the displaced backend is `close()`d) instead of leaving `services.X`
  pointing at the now-unloaded plugin's impl. Previously `unregister` only deleted from the plain
  service map — which the three swap-keys bypass on `register` — so the call was a no-op for them, and
  e.g. removing the SQLite backend left every store silently bound to the orphaned (and, had teardown
  closed it, dead) database. The boot default is whatever the app constructed at startup (the CLI:
  filesystem or in-memory per `--session`; the browser: OPFS), so the registry remembers and restores
  the app's base services rather than hardcoding a fallback. Fixed in both hosts (`apps/cli`,
  `apps/web-bundle`) via a shared `swapStorage`/`swapKnowledge` helper driving both register and the
  unregister revert.

- **Hot-swapping the `StorageBackend` at runtime is now coherent — stale caches and split
  compare-and-swaps are gone.** Three defects compounded when a backend was registered/unregistered
  while the system was live (e.g. switching the default filesystem store for SQLite without a restart):
  the swap fired *mid-turn*, so a single turn's compare-and-swap could straddle two backends; in-memory
  caches (skills, triggers) kept serving the *old* backend's documents, so the frontend "claimed
  filesystem but showed SQL"; and a backend opened by the boot pre-scan was captured *as* the host base
  and recorded no owning plugin, so unloading it neither reverted nor closed it. Now: `register/
  unregister('StorageBackend')` stage a last-write-wins pending swap that lands at the next **quiescent
  edge** (`onContextQuiesce`, reached when no turn/request/message is in flight — the pump turn switches
  context to mark that edge); the host then emits `services.mounted`, on which the cachers re-read the
  new backend (`SkillManager`/`TriggerManager` gained a re-runnable `load()` that clears and reloads,
  subscribed for the life of the plugin); and the boot base is captured *before* the pre-scan, with the
  pre-scanned backend recorded as plugin-owned so its unload reverts to that base and closes it. Fixed
  in both hosts (`apps/cli`, `apps/web-bundle`).

- **`plugin remove` no longer offers to `pnpm remove` a plugin that was never installed by the
  package manager.** The "Also uninstall the npm package?" prompt fired unconditionally, even for
  local-path plugins (referenced in place) and cached remote http/github plugins (materialized into
  `.plugins/`) — for which the package-manager command was, at best, a no-op run against a path or
  URL. It is now gated on the plugin's canonical name being a recorded dependency (mirroring the
  `add` path, which only shells out for npm / tarball-or-git specifiers), and the uninstall addresses
  the package by name rather than by the matbot.yaml entry.

- **`plugin discover_local` no longer offers a non-plugin library, and `plugin add` no longer strands
  a dead config entry when one is forced.** Discovery qualified a directory as installable purely from
  its `package.json` depending on `@matatbread/matbot-plugin-api` — but a *library* may import the API
  for its types alone (e.g. `Store<T>`) while exporting no `plugin`, so the bare
  `@matatbread/matbot-storage-filesystem` store showed up as installable and then failed at load. The
  scan now matches the loader's actual contract: a candidate qualifies only if its entry module truly
  exports a `plugin` (the dependency is just a cheap pre-filter). And if a non-plugin is added anyway
  (e.g. by hand), the loader's shape failures now throw the typed `NotAPluginError`, which the `add`
  flow treats like `IncompatibleRuntimeError` — permanent, so it **rolls the specifier back out of
  matbot.yaml** and reports a terminal "not a matbot plugin" message instead of the previous "added to
  config but activation failed" (which left a dead entry and echoed the loader's `Expected: export
  const plugin` text — a code-fix instruction an LLM would try to act on). Transient setup() failures
  (a missing secret) are still left in config to retry.

### Optional

- **web-bundle — provider profiles now persist and resolve by package name, not a build-specific
  `mbmod:` id.** Since the provider-registry refactor moved adapter loading from a boot pre-scan to
  on-demand (and stopped canonicalising modules at boot), a profile's persisted `module` must be
  *directly importable at use time*. Two gaps combined to break that: (1) the assembler baked each wizard
  adapter's `availableProviders[].module` as the synthetic `mbmod:<id>` graph-root specifier, which the
  wizard wrote verbatim into `localStorage`/Drive — build-specific, so a profile saved by one bundle went
  dead on the next rebuild (a stale one imports as an unknown-scheme URL → `mbmod:` CORS/`ERR_FAILED`);
  and (2) provider adapters were pulled into the graph only as roots, never by bare-name import, so their
  package names were absent from `packageEntries` (the import map) — the durable, rebuild-stable form
  didn't resolve either. Fixed both, mirroring how bundled plugins already work: adapter package names
  are added to the import map, and the wizard offers/persists the package name. Boot also self-heals
  older saved configs — a still-known synthetic id is repaired to its package name, a stale-across-builds
  one is skipped with a notice instead of throwing.

- **storage/google-drive — wraps its backend in `CachingStorageBackend` before registering.** Drive
  reads are slow and the harness re-reads whole namespaces (triggers, skills, providers) every turn;
  the cache serves reads locally while writes stay write-through to Drive. The browser bundle is single-
  user per session, so its own writes stay coherent with no foreign-write invalidation configured (the
  only divergence case is the same user in two browsers at once, and the Drive token expires within the
  hour); a `drive.changes.watch()` feed is noted in-code as a possible future sharpening. The `setup()`
  idempotency guard now duck-types through the wrapper (`.inner`) instead of an `instanceof` on the
  registered backend. Exposes `globalThis.__mbCache()` in the browser as a console handle onto the
  wrapper's `stats()`.

- **providers/google — native Gemini adapter (new `@matatbread/matbot-provider-google`).** One
  `module:`, two wire formats, chosen by the endpoint **path** (not host — a proxy/gateway may rewrite
  the host but keeps the path): a bare base or `…/models/{model}:generateContent` selects the native
  `generateContent` adapter; a `…/chat/completions` / `…/openai/…` path falls back to the shared
  OpenAI-compat adapter in `gemini` mode. The native adapter round-trips Gemini 3 thought signatures as
  the sibling `thoughtSignature` on each part (carried in the tool-call's `meta.google.thoughtSignature`
  — see `ProviderMeta` above), maps tool results into `user`-role `functionResponse` parts, lifts the
  system prompt to `systemInstruction`, and sanitizes tool schemas to Gemini's strict OpenAPI-subset
  (dropping `additionalProperties`/`$schema`/`$ref`…, normalising `type:[…,"null"]`→`nullable`,
  `const`→`enum`, `oneOf`/`allOf`→`anyOf`, and injecting `items` on loose arrays). The model and API key
  come from the profile's own `model:`/`credentials.apiKey` — the model is interpolated into the URL
  path, the key sent as `x-goog-api-key` (never the query string). Cross-provider replay is handled by a
  **provider-origin trust rule**: a signature is replayed only when the message that produced it came
  from the current provider — so a foreign tool-call (no Gemini signature) is elided with its paired
  `functionResponse`, and a foreign *thinking* signature (e.g. Anthropic's, which is NOT a valid Gemini
  thought signature) is dropped rather than replayed into `thoughtSignature`, which Gemini would reject
  as "Corrupted thought signature".

- **providers/openai-compat — `gemini` mode.** An opt-in mode (set by the google variant, or
  `parameters.gemini: true`) that round-trips Gemini 3 thought signatures over the OpenAI-compat wire
  (`extra_content.google.thought_signature`, stored in the tool-call's `meta.google.thoughtSignature`)
  and elides signature-less tool-call/result pairs from foreign history, so Gemini's OpenAI-compatible
  endpoint works with tools and tolerates mixed-provider sessions. Homes the `ProviderMeta.google`
  augmentation (the native `google` adapter depends on this package and sees it transitively). Off by
  default — a plain OpenAI/DeepSeek/ollama endpoint is unaffected.

- **tool-router — working set now grows append-only (better prompt-cache hits).** The windowed working
  set was ordered by registry (boot-load) order, so discovering a tool that loaded early inserted it
  mid-block and shifted the tail, invalidating the cached tools prefix every turn. It's now ordered by
  **adoption** (first reference in the transcript — a call, or the search that revealed it), so a newly
  discovered tool appends and the already-presented prefix stays byte-stable and keeps caching. No
  change to *which* tools are presented, only their stable wire order.

- **skills_compiler — codegen now sees the tool contracts it typechecks against, and demonstrations
  can prompt the user.** The derived `matbot-tools.d.ts` (live-registry tool/service contracts) was
  written to disk for `tsc` only; the generation prompts merely asserted it existed, so a model wrote
  tool calls from the skill prose and converged on the real signatures only via the typecheck-repair
  loop. The dts is now derived before codegen and embedded verbatim in all three prompts (initial,
  iterate, repair), so hallucinating a tool or signature contradicts text that is in context. The
  demonstration session now inherits the calling turn's interactive prompt channel (`ctx.prompt` →
  `run.open`), so a skill whose procedure asks the user works end-to-end when compiled interactively
  — previously every `ask_user` without a declared default failed as "Non-interactive context" and the
  demonstration stalled before the real procedure. The environment spec handed to codegen also gains
  rules that each removed an observed run-to-run divergence: progress `pct` is 0–100 (a model emitted
  0–1 fractions), an LLM step with no explicit provider is `tool.single_turn` with `provider` omitted
  (models fabricated `''`/`'default'` for `services.singleTurn`), a cancelled `ask_user` throws (a
  model let the throw abort a loop the skill said continues), and never pre-declare a variable as
  `ReturnType<typeof tool.x>` (on an overload set it resolves to the last overload alone — one model
  burned all three repair passes on the resulting misleading TS2739). Three further fixes from a
  14-round/7-provider test campaign: a distilled method returned as a JSON *array* of steps was
  silently discarded in favour of the raw demonstration transcript (arrays now accepted; all terminal
  results carry a `distilled` flag, and a genuine fallback is labelled as a RAW trace in the prompt
  instead of claiming to be distilled); a declined install confirmation (a "Cancelled." *result*, not
  a throw) was reported as `installed` and hid the source skill (the compiler now verifies the tool
  actually resolved before claiming success, and hides only on verified install); and the distiller
  now prefers spec-named neutral mechanisms over persona tools the demonstration happened to use
  (`ask_inner_voice` was leaking into compiled tools) and types enumerable result fields as literal
  unions rather than `string`. The typecheck step now runs the TypeScript compiler API in a worker
  thread (the shared checker in `@matatbread/matbot-tool-types`), replacing the shelled `tsc`
  subprocess outright — the inputs are fully determined (the compiler's own scaffold and tsconfig,
  the same resolved typescript module), so a checker failure is a plumbing bug that must surface as
  the compile's error, not be absorbed by a quieter fallback path. Structured diagnostics become
  repair feedback with the
  offending source frame caret-anchored under each error, full elaboration chains and
  related-information locations (e.g. which contract arm an expected type came from), directed HINT
  lines for the recurring strict-mode idioms (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `import type`, tool-contract arm mismatches), and cascade capping ("fix the first error first") —
  models repair from anchored snippets in one pass where bare `file(line,col)` references had them
  guessing.

- **tool-types — the checker gains a structural cast gate.** `tsc` accepts type assertions
  unconditionally, so generated code could re-assert a shape onto a value the tool proxy had already
  typed precisely — one `as any` and a hallucinated field compiles, then fails silently at runtime.
  The worker now walks the checked source and reports three patterns as `CAST-GATE` diagnostics
  through the same annotated/repair pipeline as type errors: `as any` (always), `as unknown as T`
  double assertions, and — verified against the live `TypeChecker` — widening an already-typed value
  to a loosening target (`Record<…>`, `object`, `unknown`, index-signature-only literals). Assertions
  on genuinely-unknown sources (the executor's `input`, `await resp.json()`, catch variables),
  narrowing assertions, and `as const` all pass. A dry run over the 24 previously compiled test
  sources failed 12 of them (1–3 findings each) — the prose-only rule this replaces had roughly
  coin-flip compliance.

- **tool-types — `ToolTypeIndex.check` moves off the main thread and returns annotated diagnostics.**
  The lambda type-check previously built a `ts.createProgram` synchronously on the main thread, so
  every `tool_function` define/lambda froze the event loop — and every frontend — for the duration.
  The check now runs in the same worker-hosted checker the skills compiler uses (one checker, two
  entry modes, both exported: `checkProjectDir` for a compiled plugin's build dir,
  `checkSnippetAgainst` for a virtual ambient-dts-plus-snippet module), and each diagnostic comes
  back as an annotated block — caret-anchored source frame with snippet-relative positions,
  related-information locations (which contract arm an expected type came from), and directed HINT
  lines — instead of a bare `line N: message` string.

- **function-tools — lambda's one-argument convention is enforced, not just documented.** A lambda
  declaring more than one parameter typechecked (the check grades the function against its own
  signature, not the calling convention) and then silently ran as `(paramsObject, undefined, …)` —
  `(a: number, b: number)` invoked with `{a:2,b:3}` returned `"[object Object]undefined"`. The head
  is now parsed unconditionally and a multi-param lambda is rejected up front with a corrective
  example, before anything runs.

- **cli — a provider referenced by bare package name now resolves in a source checkout (first-run
  regression fix).** `resolvePluginSpecifiers` resolved npm/scoped specifiers only against the config
  directory, but the bundled provider adapters are dependencies of the CLI, not of an arbitrary config
  dir, so a checkout never symlinks them into `<configDir>/node_modules`. The first-run setup wizard
  writes the bare package name (`@matatbread/matbot-provider-anthropic`) as the portable form, so the
  first turn failed with `ERR_MODULE_NOT_FOUND` → "Unknown provider" (surfaced lazily, on first use,
  once the boot provider pre-scan was disabled). Resolution now falls back to the CLI's own install —
  the same anchor `discoverProviders` already uses — so a bare package name resolves whether matbot is
  installed or run from a checkout. A package the user installed in their own project still wins (config
  dir is tried first); a local, unpublished adapter is unaffected (still referenced by path).

- **tool-plugin — the `provider` tool now writes and advertises the canonical package name when it
  resolves, not a path.** Reconciles the tool with the setup wizard on the location-independent form:
  `provider add` writes `@matatbread/matbot-provider-…` (and `list`/the tool description advertise it)
  whenever that name resolves, falling back to the yaml path only for a local, unpublished adapter whose
  name resolves nowhere. Whether a name resolves is a host decision (only the CLI knows its own install
  can reach a bundled adapter), so the host passes a `nameResolves` predicate to `createProviderTool`.

- **function-tools — `lambda` is now type-checked, and both actions accept `noTypeCheck` to opt out.**
  `define` already type-checked a function body against the live tool types (via `ToolTypeIndex`) before
  registering it; `lambda` now does the same before running (syntax is still gated first by the
  type-stripper, so an unparseable head simply skips the check). A `lambda` may omit its return annotation —
  TypeScript infers it, still checking the body and its `tool` calls. Both `define` and `lambda` take an
  optional `noTypeCheck: boolean` (default false) to bypass the check for the rare spurious error (e.g.
  composing a tool whose result type is `unknown`); the `define` result notes when the check was skipped.
  No behavioural change where no type-checker is available (the browser: `check()` is a no-op, so
  composition still compiles and runs — `noTypeCheck` just makes that graceful degradation explicit).

- **tool-router — windowed presentation of a large tool library (cross-platform).** A new plugin that keeps
  selection sharp as the tool set grows past the ~30–50 where models start mis-picking. It registers a
  `ToolPresenter` that advertises only `tool_search` plus a bounded *working set* — the tools called this
  session ∪ the latest search's candidates — pulling full specs (description + folded TS contract) from the
  live registry so the model always selects and calls from complete definitions, never a bare summary.
  `tool_search` ranks the whole library (BM25 over name/description/params, plus a per-tool noun + "width"
  derivation) and returns a lean discovery record; the presenter promotes the matches into the working set on
  the next loop iteration, where they become natively callable. A turn-distance *cull* bounds the working set,
  and parallel `tool_search` calls in one turn are unioned so a strict (first-party) provider can call every
  surfaced tool.

- **browser / web-bundle — browser tools now carry their real TypeScript wire contracts (params AND result),
  not just a call shape.** The browser `ToolTypeIndex` previously emitted a wire contract only for tools with a
  runtime `toolContract` string, so every source-augmented native tool reached the model with its base
  description and `inputSchema` alone — no TS — because a `ToolContracts` augmentation is type-only and is
  stripped from the baked bundle (the model was left guessing parameter shapes). Contracts are now recovered by
  a compiler-free source scan (`extractToolContracts`): node's extraction is purely textual (read the
  `ToolContract<Result, Params>` type-argument text; the compiler is only needed to *merge* declarations), so
  the browser does the same. The assembler bakes contracts for the built-in graph into the artifact
  (`payload.toolContracts`, from the raw pre-strip sources), and http-loaded plugins are scanned at load time
  (`loadRemote` returns each module's raw source; `loadPlugin` merges via `ToolTypeIndex.addContracts`) — so a
  remotely-loaded plugin's tools get real TS too. `wireContracts()`/`dts()` now prefer a baked/loaded contract,
  then a `toolContract` string, then schema-derived params. The node runtime is unchanged.

- **frontend-web — every tool row in the sidebar now has a trigger (⚡) icon that manages that tool's
  triggers.** The icon is blue when the tool has one or more triggers and grey/translucent when it has none
  (always clickable — that's how you add the first one); per-tool counts come from a single
  `trigger_action { action: 'list' }` grouped by `invoke.tool` (absent triggers plugin ⇒ no icons). Clicking
  opens a new popup listing the triggers whose `invoke.tool` is that tool (`query`), one card each: an Enabled
  toggle, a **Parameters (JSON)** field (params are tool-specific, so free-form JSON rather than a per-tool
  form), and the OR-ed condition rows reused from the skill editor. Save reconciles against what was loaded —
  `add`/`update` cards with conditions, `remove` any deleted card — and always passes `tool` on `update` so
  clearing the params field clears the stored params. This is the general trigger-management surface for every
  tool; the skill editor's Triggers tab remains the skill-specific path (both edit the same store).

- **sessions — `session_action` gains a `query` action that searches session *contents*.** Previously the tool
  could only `list` sessions (returning a `preview` — just the first user message truncated to 60 chars), so a
  model hunting for a past conversation had to eyeball previews or `get` sessions one by one; the description now
  also states plainly that `preview` is a display label, not a summary. `query` exposes two *synthesized* string
  fields to the existing store-query grammar — `user` (everything the user said) and `assistant` (everything the
  assistant said), each the concatenation of that role's `type:'text'` blocks with tool calls/results, thinking,
  images and markers dropped as noise — so e.g. `{ where: { op: 'stringContains', field: 'user', value: 'invoice'
  } }` finds sessions where the user mentioned invoices, and the two fields OR/AND freely with each other and with
  the real stored fields (`status`, `title`, `createdAt`, `updatedAt`). Matching on the synthesized fields is
  case-insensitive (they are lowercased and the tool lowercases `stringContains` operands aimed at them, recursing
  through `and`/`or`/`not`). Optional `sort` (stored fields only), `limit`, and an opaque `cursor` paginate; a low
  `limit` **early-exits** — the search stops synthesizing/scanning the moment the page is full, so "find the 3
  sessions mentioning X" over hundreds of sessions never searches the tail. Adds a `@matatbread/matbot-core`
  dependency (the plugin now reuses `compileFilter`/`applySort`/`validateQuery` from `./storage-base`).

- **mcp — persisted servers now reconnect in the background instead of blocking boot.** `setup()` used to
  `await` reconnecting every persisted MCP server (each a full `initialize` + `tools/list` handshake — an
  `npx` cold-spawn for a local, an HTTP round-trip for a remote) before returning, so one slow or unreachable
  server stalled the *entire* startup sequence (measured: a single-digit-ms boot dominated by ~6.4s of MCP
  reconnects). It now registers `mcp_action` synchronously and fires the reconnect without awaiting it; each
  server's proxy tools appear as it comes online (the tool registry and the web `/tools` gate tolerate
  late-arriving tools). The background task is dispose-aware — teardown/unload sets a flag it checks after
  every await, closing any client and unregistering any tools it connected after teardown ran, so an
  in-flight reconnect can't outlive the plugin. `teardown` now also unregisters local proxy tools (previously
  it closed the clients but left the tools registered).

- **frontend-web — the `/tools/:name` HTTP endpoints no longer 404 a tool that is merely late to register
  at boot.** The web server starts listening inside frontend-web's `setup()`, which runs before the plugins
  configured after it (and before the core tools registered once loading finishes) have populated the tool
  registry. A page refresh during that window fired its bootstrap calls (`session_action`, `provider`,
  `about_matbot`, `skill_action`, …) ahead of those tools' registration, so they 404'd as if unloaded; a
  later refresh worked. Both `POST /tools/:name` and `POST /stream/tools/:name` now resolve against the live
  registry and, if the name is absent within a grace window from server start, wait for its `registered`
  event (subscribing before re-checking, so a registration in the gap can't be missed) rather than 404. After
  the window an unknown name is still an immediate 404, and a client disconnect aborts the wait. Resolution is
  unchanged otherwise — this is a race guard on the registry, never the `ToolPresenter` (which only culls what
  the *model* is shown; HTTP references tools by name).

- **tool-plugin / browser — `plugin add` no longer skips the config write on a prefix-sibling, and `remove`
  clears a failed-load record.** Two fixes to the plugin-management tools, both surfaced by the new
  failed-plugin recording: (1) `addPlugin` matched the specifier as a *substring* (`text.includes('- ' +
  specifier)`), so adding `./plugins/tool-router` while `./plugins/tool-routerx` was already configured was
  treated as already-present — the plugin loaded (active in-memory) but was never persisted to `matbot.yaml`,
  vanishing on restart. It now matches the specifier as a whole list item (anchored, end-of-line). (2)
  `remove` (node + browser) now calls `clearFailedPlugin(specifier)` after dropping the config/extras entry,
  so removing a plugin that never loaded (a bad path, an incompatible runtime, a `setup()` throw) also clears
  its `failed` record instead of leaving a ghost in `plugin list` / the web panel.

- **Every built-in tool declares its TypeScript contract as a `ToolContracts` arm (or `toolContract`).** Every
  built-in tool across the plugin suite — `plugin`/`provider`, `session_edit`/`compact_sessions`,
  `session_action`, `skill_action`/`skills_config`, `skill_compiler`, `trigger_action`/`triggers_config`,
  `store_action` (+ the dynamic per-store tool), `remember_fact`/`dream_time`/`ask_inner_voice`/
  `cognition_config`, `bash`/`bash_config`, `http`, `workspace_action`, `background`/`every_action`,
  `whoami`, `ask_user`, `mcp_action`, `tool_function`, `single_turn`, `about_matbot`, and the
  browser/frontend tools — now declares one `ToolContract<Result, Params>` arm per action (single-action tools
  get a single arm), and the redundant `type XAction`/`SHAPE` blocks were removed from descriptions. The
  contract is the augmentation alone: the wire `params`/`result` text is derived from the arms and folded
  into the description at the dispatch edge, and read off the live registry by `ToolTypeIndex` — one source
  of truth instead of a hand-maintained duplicate in prose. The two genuinely source-less tools (the
  `tool-store` per-namespace CRUD tool, whose name and shape are per-store; a `function-tools` function)
  carry a `toolContract` string instead. Documentation blocks that were not mere param restatements were
  kept (the `plugin` specifier grammar, `ask_user`'s field examples, `store_action`'s `StoreQuery` grammar,
  `cognition_config`'s field-range interface). Net effect: leaner descriptions, one typed contract per tool.

- **triggers** — `trigger_action` gains first-class **`disable`**/**`enable`** actions (both take `id`,
  return the updated trigger). A disabled trigger is kept but excluded from evaluation entirely, so it stops
  firing without losing its conditions and invocation — the "less aggressive than `remove`" option for a
  trigger that fires too eagerly; `enable` restores it exactly. This surfaces the existing `enabled` flag
  (already honoured by `evaluate`) as discoverable intent rather than a param on `update`.

- **tool-types** (new plugin, node-only) — provides the `ToolTypeIndex` service (see API gaps filled): it
  derives and caches a `.d.ts` of the loaded tools' result/service types, invalidating on any tool-registry
  change (`tools.watch()`). The scan is driven off the loaded plugins' `resolvedUrl`s (via `getRegisteredPlugins`,
  hence a `matbot-core` dependency) so compiled (`compiled-plugins/`) and installed (`.plugins/`) plugins are
  read from their real source, unioned with a monorepo `plugins/` glob for host-constructed builtins. A
  source-less tool's `toolContract` string is appended, referencing `ToolContract` bare against the dts's own
  top-level import (no per-entry inline `import(...)`). The tool-result-type derivation (`buildMatbotToolsDts`)
  moved here from `skills_compiler`, which now consumes it as a dependency (still falls back to its static DTS
  when the derivation yields nothing).

- **browser** — a registry-driven `ToolTypeIndex` (`createBrowserToolTypeIndex`), the browser counterpart to
  the node-only `tool-types` plugin. With no TypeScript compiler or filesystem in the browser, it derives the
  `.d.ts` from the **live registry alone**: a source-less tool's `toolContract` verbatim, and for every other
  tool a params type synthesised from its `inputSchema` (result stays `unknown`) — so `tool_function`'s `types`
  action returns real declarations instead of an empty dts. `check()` is a no-op (`[]`) since there's nothing
  to compile against, and `wireContracts()` flattens each `toolContract` for the dispatch-edge fold. Wired into
  `web-bundle` and passed to the session runner.

- **web-bundle** — the sucrase type-stripper now runs with `disableESTransforms` + `keepUnusedImports`, i.e.
  it strips types and nothing else: `??`/`?.` stay native (previously sucrase rewrote them to
  `_nullishCoalesce`/`_optionalChain` helpers) and imports are kept verbatim, matching node's stripper and the
  evergreen target the bundle assumes. Fixes a `_nullishCoalesce is not defined` crash when `tool_function`
  compiled a user function containing `??`/`?.`: the wrapping `return (async function …)(…)` turned sucrase's
  injected top-level helper declarations into named function *expressions*, out of scope for the body's calls.

- **function-tools** (new plugin, cross-platform) — a single `tool_function` tool that lets the model author
  and run small TypeScript functions which orchestrate other tools in one pass, so several tool calls can
  be composed (filter, count, reshape) without routing each intermediate result back through the model.
  Inside a function, `await tool.<name>(params)` runs any registered tool through an injected `tool` proxy
  and resolves to its structured result. `define` persists a **named** function and registers it as a new
  tool of the same name (parameters derived from the signature; optional `description` documents the tool;
  survives restart; re-defining recompiles);
  `lambda` compiles and runs an **anonymous** one-argument function once against given `params`; plus
  `list` / `remove`. Types are erased by the host's `TypeScriptStripper` (node's native stripper; the
  browser bundle's sucrase), so the plugin is cross-platform with no stripper of its own, and the body is
  compiled via the async function constructor as an immediately-invoked expression, so tool calls (and
  recursion) are awaited; each sub-call is echoed to stdout for an observable trace.
  When the `ToolTypeIndex` service is present (node), the plugin is type-aware end-to-end: a `types` action
  returns the `.d.ts` of what the available tools return (so the model composes against real types instead
  of guessing); `define` **type-checks the function body** against those types before registering, rejecting
  it with diagnostics on error; and a defined function carries its own result/param types on its registered
  tool, so later functions compose it with real types too. Where the service is absent (the
  browser), the pre-registration type-check is skipped and the function still compiles and executes.
  Bundled into the browser artifact (`web-bundle`), backed there by `@matatbread/matbot-browser`'s
  registry-driven `ToolTypeIndex` (below): `types` returns real declarations derived from live tools'
  `toolContract`/`inputSchema`, so composition is type-aware even in the browser — only `check()` is a no-op
  (no compiler), leaving `define` permissive.

- **skills_compiler** — a compiled plugin now **declares its tool's contract as a `ToolContracts`
  augmentation** in its generated `src/index.ts`: `${toolName}: ToolContract<Result, Params>`, where `Params`
  mirrors the generated `inputSchema` (accurate by construction) and `Result` is the distiller's reading of
  the value actually observed in the demonstration trace (kept self-contained). Because a compiled plugin has
  real source on disk, that augmentation IS its single contract — the same form every built-in tool uses —
  so another tool composing `await tool.<name>(…)` gets real types once the compiled plugin's source is
  scanned. The generated executor binds `ToolExecutor<ToolResultOf<'${toolName}'>>`, so the existing
  typecheck **verifies the implementation actually yields that shape** — the declared type is checked, not
  merely claimed (uniform whether the result is concrete or `unknown`). The distiller is told to include
  every observed field, so the verified type is complete; because its type and the generated implementation
  both derive from the same demonstration run, this does not cost extra repair passes in practice. The
  consumer `.d.ts` baked alongside the plugin excludes any prior compiled version of the same tool, so its
  fresh augmentation is the sole declarant of its own name.

- **skills_compiler** — the compiled plugin's **package name and tool name are now configurable**, and
  recompiling to the same destination **bumps the version**. `skill_compiler` takes optional
  `packageNamePrefix` (default `@local/compiled-`, changed from `@matatbread/matbot-compiled-`) and
  `toolName` (default the skill's safe name, e.g. `Send To Telegram` → `send_to_telegram`); the package
  name is `<prefix><toolName>` and the on-disk directory follows the tool name, so a given skill compiles
  to a stable, predictable destination. A recompile reads the version already on disk and bumps its patch
  (first compile: `0.1.0`) rather than silently rewriting the same version. The distiller is no longer
  asked to name the tool — naming is now deterministic, which is what makes the stable destination (and
  thus the version bump) meaningful.

- **mcp / mcp-http** — the `mcp__<server>__` proxy-tool-name prefix is now **overridable per server**.
  `mcp_action add` takes an optional `proxyToolName` — the prefix each of a server's tools is registered
  under, replacing the default `mcp__<name>__` — persisted on the connection config (`MCPRemoteConfig` /
  `MCPServerConfigLocal`) so `list`, `remove`, and reconnect all recompute the same names. Absent ⇒ the
  previous default, so existing connections are unchanged.

- **frontend/telegram** — fixed a boot crash (`No provider registered for module "…". Available: none`)
  that unloaded the plugin at startup. It called the removed `resolveProviderFactory(config.module)` from
  `setup()` to eagerly build an adapter, but with the provider pre-scan disabled no factory is registered
  yet, and the factory registry is keyed by plugin name rather than the profile's module specifier. The
  frontend now holds only the active provider **name** (validated against `services.providers`) and lets
  the runner resolve the adapter per turn via `complete()` → `instantiateProvider` — the eagerly-built
  adapter was never used. Also removed the now-dead `resolveProviderFactory` export from `core`.

- **storage/google-drive** — provider profiles now **sync to Drive**, mirroring the existing plugin sync.
  `setup()` shadows the `provider` tool with one backed by a Drive `provider-manifest` store (the same
  `createBrowserProviderTool`, now backed by a Drive `ProviderAdmin`), so `add`/`remove` write across
  machines; the API key goes to the already-swapped DriveVault while the profile stores a `${NAME}`
  placeholder. Stored profiles are replayed into `services.providers` on boot and reverted on unload,
  restoring any boot profile they shadowed.

- **provider-store-test** (new; demonstration/reference) — a node plugin that contributes provider
  profiles from its own store and reverts them on unload. It has no real use in a node environment (it
  just clones a configured provider); it exists as a runnable proof of the provider-contribution path and
  as a template for centralising provider config in a shared resource (a database, a config service, …).

- **mcp-http** — remote HTTP MCP connections now **self-configure the `MCP-Protocol-Version` header**.
  Browsers preflight that header, and servers that don't allow it rejected every request outright (a CORS
  failure from a `github.io`-style origin). The client now probes on first connect: it tries **without**
  the header (which satisfies the narrower preflight, so those servers work) and adds it back only for a
  *reachable* server that rejects the header-less request with a non-ok HTTP status — never on an opaque
  fetch/CORS throw, where a header can't help. When the header is needed, it carries the version the
  server negotiated in `initialize` (previously a hardcoded constant), so servers on different protocol
  versions get the right one. The resolved policy is cached on the client and persisted to the connection
  store (`MCPRemoteConfig.protocolVersion`: a version string to send, or `null` to omit), so later
  reconnects skip the probe. No new tool or add-time option: existing connections re-probe once on next
  reconnect.

- **skills / skills_compiler / frontend/web** — a skill can now be **hidden**: withheld from the model
  (retracted from the knowledge index, so `contextual_search` / `find_fact` can't surface it, and
  excluded from the system-prompt catalogue) while staying fully manageable. New `SkillDoc.hidden` flag,
  set/cleared only by two new `skill_action` actions — `hide` / `unhide` — and **never touched by
  `save`**, so a content edit preserves it; the manager retracts the index entry on hide (awaited, so a
  racing search can't still surface it) and re-indexes on unhide. `skill_action list` and `metadata` now
  report the `hidden` state. The **skill compiler** uses this to complete the retirement of a compiled
  skill: after moving its firing triggers onto the new tool, it hides the source skill (kept as the
  compiler's source), so the deterministic tool answers the condition instead of the skill prose being
  injected or searched. The **web skills panel** lists hidden skills below the visible ones in the same
  paler grey as inactive plugins, with a hide/unhide toggle on each row.

- **skills / skills_compiler** — a skill's procedural/informational split is now derived once by the
  skills metadata analysis pass and cached on `SkillDoc.knowledge.classification` (two independent 0–1
  confidences, `{ procedural, informational }`), instead of being re-classified by the skill compiler on
  every run. `skill_action metadata` surfaces it. The compiler reads the cached scores: it compiles a
  skill only when `procedural > informational`, and returns `no_metadata` (no longer self-classifies)
  when the analysis pass hasn't run yet — re-saving the skill regenerates the metadata. Existing skills
  pick up the field on their next content change.

- **skills_compiler** — compiled plugins are now written with `node:fs` to a dedicated, gitignored
  `compiled-plugins/` directory (a module-level `COMPILED_PLUGINS_DIR` constant, relative to the project
  root) and installed from there, instead of being routed through `workspace_action` into
  `.data/files/`. That removed a hidden runtime dependency on the workspace plugin (the compile failed
  if it wasn't loaded) and a false assumption that the file store materialises on the local filesystem;
  it also drops the `.meta.json` sidecars the file store left in the build dir. The location is
  deliberately neither `.data/` (the LLM's read-write space) nor `.plugins/` (the re-fetchable remote
  cache — a compiled plugin has no upstream, so a cache clear would lose it). Install is now a *soft*
  dependency on the `plugin` tool: if it isn't loaded, the plugin is fully built on disk and the result
  is `compiled_not_installed` with the specifier, rather than a hard failure.

- **skills_compiler** — typechecks the generated plugin by running the real `tsc` binary (resolved from
  the `typescript` dependency — no `npx`) as an **awaited async subprocess**, rather than a blocking
  `execSync`/in-process compile. Synchronous typechecking pinned the event loop and froze the web UI for
  its whole duration; the async child process keeps the loop free. `typescript` is now a real
  `dependency` (it was a devDependency despite being needed at runtime).

- **skills_compiler** — typecheck failures now self-repair instead of being terminal. The
  generate→write→`tsc --noEmit` step is a loop (up to 3 passes): on failure the tsc errors and the
  current `src/index.ts` are fed back to the code generator, which returns a corrected whole file, and
  it re-checks. The repair loop owns the broken file, so the calling LLM no longer has to hunt for and
  hand-patch it. Only after the passes are exhausted does it return `status: 'typecheck_failed'` (now
  with `passes`); the success result reports how many passes it took.

- **skills_compiler** — generated code now reads tool results through the typed `toolResult` (not
  `toolText` + `JSON.parse`/regex), and the compiler ships a `matbot-tools.d.ts` alongside the plugin so
  its separate compilation sees the common tools' result types (`ask_user`, `find_fact`,
  `contextual_search`) — so a wrong-shape access is a compile error the repair loop catches rather than a
  silent runtime failure. Codegen is also now told to implement every branch the skill describes (each
  arm of a conditional), not just the path the worked example happened to exercise.

- **skills_compiler** — the `matbot-tools.d.ts` shipped to each generated plugin is now **derived from the
  live type graph** instead of a hardcoded three-tool list. At compile time the compiler builds a TS
  program over the workspace's tool/service packages, reads the merged `ToolContracts` **and**
  `MatbotServices`, and emits a self-contained `declare module` — **bundling** each referenced
  package-private interface/type-alias into the DTS (recursively), importing plugin-api types, and
  replacing any `node_modules`/class/enum/unresolved *leaf* in place with `unknown /* … */` (so a
  signature like `(req: unknown /* IncomingMessage */) => …` stays usable rather than collapsing). The
  result: a generated plugin gets correct `toolResult` types (with per-action narrowing for multi-action
  tools) for **all** built-in tools, plus typed registry services on `services.*` (`SkillManager`,
  `Triggers`, …). The program roots are the **live loaded-plugin set** — each plugin's `resolvedUrl`
  (obtained via the `plugin` tool's `list`, so it's replaceable and matches what the LLM sees), so
  coverage follows the actually-loaded plugins (npm / `.plugins/` / local), not just the monorepo tree —
  falling back to a monorepo `plugins/` glob, then to the static list, when neither is available. The
  derivation runs in-process (briefly blocks the event loop); a build cache is a possible follow-up.

- **skills** — `SkillManager` is now an **interface** (implemented by `SkillManagerImpl`) rather than a
  class, so the registry key carries an interface like every other service (and the type is bundlable
  into the generated-plugin DTS). Consumers are unaffected (all used `import type { SkillManager }`).

- **skills_compiler** — code-generation guidance now forbids extracting a value from another tool's
  natural-language output with a regex / fixed-phrase match (a brittle anti-pattern that silently fails
  when the wording differs), and directs single-fact lookups to the structured `find_fact` tool instead
  of `contextual_search` + string-parsing — translating the spec's tool choice when it names
  `contextual_search` for what is really a single-datum lookup. The machine-API surface handed to codegen
  now documents `find_fact`'s structured shape. Generated code is also now told to forward the whole
  `ctx` to `invokeTool` (4th arg) rather than a hand-picked `{ session, signal }` subset, so a callee
  that needs an LLM inherits the turn's provider — fixing compiled tools failing with "no provider".

- **rumsfeld** — new `find_fact` tool: a granular companion to `contextual_search`. Where
  `contextual_search` returns the single best-matching knowledge *document* to read (right for "load me
  this skill/context"), `find_fact` is for retrieving one specific *datum* (a city, URL, date). It
  searches the `KnowledgeIndex`, reads across the top matches (so a fact in a lower-ranked entry isn't
  lost the way `contextual_search`'s top-entry-only return loses it), extracts the answer via the turn's
  provider, and returns `{ found: true, fact, source? }` or `{ found: false }` — never a guess. Falls
  back to a configured provider when the caller doesn't thread one, so it degrades gracefully rather
  than hard-failing.

- **rumsfeld** — sharpened the `contextual_search` tool description: terms must be specific
  identifiers (proper nouns, named systems, personal identifiers), not bare generic nouns that collide
  with any document merely discussing the topic, and deictic/self-referential queries ("here", "where
  am I?", "my location") should resolve to the *user* (search their identifier/profile) rather than the
  common noun. Addresses the term-quality root cause of generic searches returning topically-adjacent
  skills instead of the fact being sought.

- **frontend/web** — a tool's live progress `message` is now shown as a floating pill in the top-right
  of its `tool-block` (previously only a hover `title`), so step-by-step progress (e.g. the skill
  compiler's "repairing (pass 2/3)…") is visible at a glance. The pill is removed on `tool:end`.

- **frontend/web** — the skill editor's metadata pane now shows the procedural/informational
  classification as two labelled 0–1 bars, alongside the existing summary/entities/tags.

- **tool-plugin** — `plugin reload` now re-downloads a changed remote (github/http) plugin instead of
  silently re-importing stale code. The `.plugins/` cache is write-once (skip-if-present), and reload's
  cache-bust only re-*evaluated* the already-cached bytes, so a changed remote source could never reach
  a running matbot short of manually deleting its `.plugins/` subtree. Reload now evicts the plugin's
  cached subtree (and its `node_modules/<name>` self-link) and clears the in-memory manifest memo before
  re-materialising. It is governed by a new optional `refresh` parameter on the `reload` action
  (default **true** — reloading a remote plugin means "pick up the latest upstream source", the
  cross-source analog of how a local reload always reflects on-disk edits); pass `refresh: false` to
  re-run `setup()` against the cached copy without a network round-trip (reset state, or work offline).
  The capability is threaded through the runtime as a new optional `refresh` arg on
  `MatbotRuntime.loadPlugin` / `ToolContext.loadPlugin` (default **false** — a programmatic load stays
  cache-first). Boot and `plugin add` are unchanged.

- **frontend/web** — new `web_user_environment` tool: the LLM evaluates a JavaScript expression in the
  user's attached browser and gets the JSON-serialisable result back. It runs in a sandboxed Web Worker
  (built from a blob URL, so it works from the `file://` bundle too) with no DOM, storage, cookies, or
  permission-gated sensors — read-only introspection of the standard web platform for ambient facts like
  timezone, locale, and user-agent, leaning on the model's own knowledge of browser APIs rather than a
  per-capability tool. Round-trips over the session SSE stream (a new `web-env-eval` event answered via
  `POST /sessions/:id/env-result`), registered identically in both UIs (the Node server and the
  in-process browser bundle) from one shared tool definition — only the transport differs.

- **frontend/web** — fixed a regression that broke the **browser bundle entirely**: `browser.js`
  imported the removed `PromptCancelledError` class as a value (it is now a type-only export plus the
  `promptCancelledError()` factory), so the in-process transport failed to link and the whole UI never
  mounted. Now uses the factory, mirroring the Node server.

- **edit-session** — new `compact_sessions` tool: applies the compaction policy across the *whole*
  session store, in two tiers — **full compact** (archived or >28 days idle: strips all tool calls,
  tool results, and thinking blocks) and **partial compact** (active sessions with >20 messages,
  keeping the last 10 intact). Never touches the current session and is idempotent, so it is safe to
  run on a schedule or as a background task; it should always be user-initiated, not model-invoked
  mid-turn. Per-session compaction stays `session_edit({ action: 'compact' })`.

- **apps/cli** — sub-agent status is now shown at startup.

- **cognition** — the inner-voice (`ask_inner_voice`) tool now emits an empty output chunk so its
  result reliably renders in the UI; and `dream_time`'s merge length-guard gains a 20-character buffer,
  so trailing-whitespace edits the merger makes no longer trip a false truncation failure.

- **apps/cli & frontend/web** — per-turn token usage is now reported **broken down by provider**,
  computed from the persisted session at turn end (so it includes spend by tools that ran their own
  completions — `single_turn`, `ask_inner_voice`, `dream_time`) rather than from the live main-turn
  `usage` stream (now legacy). Zero counts are elided. The CLI prints one line per provider; the web
  client's `tokens` block lists a row per provider. Backed by the new core helper `usageByProvider`.

- **providers/openai-compat** — opt-in prompt caching. With `parameters.promptCache: true`,
  the adapter sends Anthropic-style `cache_control: {type:'ephemeral'}` breakpoints on the system
  prefix, the tool defs, and the second-to-last user turn (mirroring the native anthropic adapter),
  and reads `usage.prompt_tokens_details.cached_tokens` back as `cacheReadTokens`. Unlocks prompt
  caching for Anthropic/Gemini/Qwen routed via OpenRouter (and surfaces OpenAI/DeepSeek automatic
  caching). Default off — a plain OpenAI or local (ollama/vLLM) endpoint never receives
  `cache_control`, so the flat OpenAI wire shape is unchanged.

- **web-bundle** — insecure-context Web Crypto shims, consolidated in the bundle loader
  (`apps/web-bundle/src/loader.js`), so the single-file bundle works over plain HTTP on a non-localhost
  origin. A non-secure browsing context withholds `crypto.randomUUID` and `crypto.subtle` (only
  `crypto.getRandomValues` survives); since the bundle runs the whole runtime — core, every plugin,
  the bootstrap — in one page, that previously crashed plugin load (`crypto.randomUUID is not a
  function`, called in 20+ packages) and skill reindexing (`crypto.subtle.digest` of undefined). The
  loader now installs a `getRandomValues`-based `randomUUID` and a SHA-256-only `crypto.subtle.digest`
  (verified byte-for-byte against SubtleCrypto; the bundle's default vault is plaintext, so no AES-GCM
  shim is needed) before importing any module. Each installs only when missing, so secure contexts are
  untouched. The previous partial polyfill in the web frontend's `app.js` (which ran too late to help
  the bundle) is removed.

- **triggers** — a fourth trigger `kind`, **`contextual`**, and a rename of the user-surface kind
  `augment` → **`ephemeral`** (forming an ephemeral/durable pair on the user surface). `contextual`
  judges the user message in the `screen` hook like `ephemeral`, but folds the fired tool's output
  *durably* onto the user turn (via the new `ScreenResult.durable`) instead of injecting it for one
  turn — for when a match means "this should become part of the session", not "use this for this
  answer". Within a single trigger `contextual` dominates `ephemeral` (a durable fold is also sent on
  the firing turn, so it loses nothing — mirroring retract-over-followup on the agent surface). The
  ephemeral injection is traced by a `durable-inject` marker recording only the firing sources (the
  text itself now persists in the user message). Stored triggers and built-in cognition seeds are
  migrated `augment` → `ephemeral` idempotently on plugin load (trigger docs live in `.data/`, outside
  source), and the retract-redo suppression cause is renamed `augment-redo` → `user-redo`. The
  `trigger_action` tool guidance/schema and the web skill-editor kind picker list all four kinds.

- **storage-google-drive** (`@matatbread/matbot-storage-google-drive`, browser) — a
  `StorageBackend` that persists all documents and file blobs to a folder in the user's
  Google Drive, so chats, settings, skills, files and secrets follow them between browsers and
  machines. Layout mirrors the filesystem backend: `<root>/<namespace>/<id>.json` documents
  (read into memory once, write-through, per-store mutex) and `<root>/__files/` blob+meta pairs.
  In-browser auth via Google Identity Services — the non-sensitive `drive.file` scope (only files
  matbot creates), a public client ID, no server or secret. Sign-in is driven from the setup
  overlay's **Connect** button (the user gesture Chrome requires to open the consent popup — a
  boot-time popup is blocked), and the overlay walks through the one-time Google console setup
  (create OAuth client, enable the Drive API, add a test user). Connectivity is probed before the
  backend is swapped in, so a misconfigured project (e.g. Drive API not enabled) leaves the
  session on local storage with a clear message instead of erroring on every operation. It also
  **re-points the vault at Drive** (secrets sync, migrating any held in localStorage) and
  **shadows the built-in `plugin` tool** with a Drive-backed one — same name, so there's no
  ambiguous second tool — so installs sync across machines: `add` → Drive; `remove`/`reload` →
  Drive if synced, else delegated to the local tool; `list` marks each plugin Drive-synced or
  local-only. Opt-in: baked into the web bundle, activated with `plugin add`. Web-bundle only
  (the node-served runtime keeps its filesystem/SQLite backend).

- **storage-filesystem** (`@matatbread/matbot-storage-filesystem`, node) — now also an installable
  `StorageBackend` plugin, not only a bare `FilesystemStore` library. The package keeps exporting
  `FilesystemStore` for the host to wire as its zero-plugin boot base (apps/cli is unchanged), and adds
  a `plugin` export (`FilesystemStorageBackend`: `<dotData>/<namespace>/<id>.json` documents +
  `<dotData>/files` blobs, the exact layout the node host already falls back to) with a `storageBackend.
  open` boot hook and a `setup()` that registers it — mirroring the SQLite/Drive backends. The point is
  to make the node default *nameable*: `plugin add @matatbread/matbot-storage-filesystem` asserts it to
  override another backend, instead of only reaching it implicitly by unregistering whatever is in
  force. (Pairs with the discovery/`add` fix above: it now appears in `discover_local` because it is a
  real plugin, rather than a library that fails on install.)

- **web-bundle / browser** — supporting changes for the above: the browser realm now honours
  `register('Vault', impl)` (a capture-safe `forwardingProxy` over the active vault, mirroring the
  CLI's swap), so a plugin can replace the secret store at runtime; and the browser defaults plugin
  now persists its auto-load list to the *concrete* boot backend (captured at setup) rather than
  through the swappable store proxy, so a plugin that swaps the `StorageBackend` during its own load
  (e.g. storage-google-drive) reliably records itself in the list instead of writing into the
  just-swapped-in backend (which boot would never read) — this also repairs the mirror bug on
  `remove`.

- **triggers** (`@matatbread/matbot-triggers`, cross-runtime) — a data-driven
  hooks subsystem. A `Trigger` is a stored
  `{ conditions: { kind: 'augment'|'retract'|'followup'; rule }[]; invoke: { tool; params? } }`
  document; when an LLM classifier judges any condition matched against the current turn,
  the named tool is invoked. A condition's `kind` is a single discriminator fixing the
  surface judged, the hook, and how the tool's *output* reaches the model:
  `augment` (judge the user message in `screen`; inject the output ephemerally into the
  turn about to run), `retract` (judge the assistant response in `followup`; the response
  is *wrong*, so discard it and re-run the user turn with the output injected —
  `retractAndRerun`), `followup` (judge the assistant response; it *stands* but needs a
  steer, so keep it and resubmit the output as a robo turn — e.g. Inner Voice / Verify
  Assumptions, which need the response in context). A tool that yields no result runs as a
  silent side-effect. Injected payloads are fenced as system-supplied context (so the
  model doesn't read them as the user speaking), and an `augment` injection (otherwise
  never persisted) leaves a diagnostic `triggers` marker (`data.event:
  'ephemeral-inject'`) recording what was fed in, for post-mortem tracing. Two re-fire
  guards keep an agent-phase retract from amplifying: a retract *redo* re-runs the same
  user turn, so user-phase (augment) triggers are **held off** on a redo (else their side
  effects — e.g. `remember_fact`'s store write — double-apply), and a retract rule that was
  *active* on the previous turn (fired **or** itself held off) and is still matching is held
  off as non-converging — so it stays suppressed turn after turn while it keeps matching
  (each suppression re-arms the guard) rather than oscillating fire/suppress, and un-sticks
  only when the rule genuinely stops matching (a well-behaved rule self-terminates and never
  hits this). Both hold-offs are recorded with a `data.event: 'suppressed'` marker (a machine
  `cause` + human `reason`) — suppression is never silent, so a later "why didn't it fire?"
  is answerable from the session. The surface a condition is judged on (user message vs
  assistant response) is *derived* from `kind` (`surfaceOfKind`), not a stored field. This
  generalises skill-firing — "fire skill X" is just `invoke: skill_action({ action: 'use' })`,
  no longer special-cased (`use` applies the skill as a directive; `load` returns raw content
  and is not for firing). Exposes a `Triggers` service (CRUD + `importIfAbsent`, idempotent
  by invocation) and a `trigger_action` tool (`list`/`query`/`get`/`add`/`update`/`remove`;
  `query` filters by invoke target). An absent target tool degrades soft (does nothing
  until present). (See `docs/TRIGGERS-RATIONALE.md` for the *why*.)

- **skills** — a skill can be flagged a **system skill** (`SkillDoc.catalogue: boolean`): when set,
  it's advertised in the always-on system-prompt catalogue, using its generated `knowledge.summary`
  (or the optional hand-written `catalogSummary` override, when present). `skill_action(save)` takes
  an optional `catalogue` boolean (omit to leave unchanged) and `metadata` returns the current flag;
  the always-on contributor now advertises only `catalogue === true` skills (skipping any without a
  summary yet). The web skill editor's metadata pane gains a "This is a system skill" checkbox,
  persisted on save (the summary itself isn't hand-editable yet — the generated one fills the blank).
  This is how the former `system`-phase trigger's catalogue role lives on, as data rather than a trigger.

- **skills** — trigger ownership moved out to `@matatbread/matbot-triggers`. Removed the
  `skill_triggers` tool, the embedded `SkillDoc.triggers` array, and the two
  trigger-evaluation hooks. The former `system`-phase trigger (the system-prompt skills
  catalogue) is now a `SkillDoc.catalogSummary` field. Skills are content + catalogue
  only; firing on a condition is a trigger whose `invoke` is `skill_action(use)`.
  Breaking for skills-*package* consumers: dropped exports `SkillTrigger`,
  `TriggerPhase`, `createSkillTriggersTool`. (Existing installs: embedded `triggers`
  arrays in stored skill docs go dormant; a one-off offline migration moves them into
  the triggers store and `catalogSummary`.)

- **cognition** — seeds its built-in skills' triggers into the `Triggers` service (one
  use-trigger per skill, conditions grouped) instead of embedding them, discovering
  `Triggers` off the registry the same way it discovers `SkillManager`.

- **cognition** — the "Remember this" skill is **retired**: it was compiled by hand into the
  `remember_fact` tool, so the prose `SkillDoc` is gone and its conditions now live as data
  (`REMEMBER_CONDITIONS`) firing the tool. `remember_fact` now captures from **whichever message
  fired it** — the latest non-robo user *or assistant* message (an `augment` condition fires
  pre-response so the tail is the user message; a `followup` condition fires post-commit so the
  tail is the assistant response, e.g. promising to remember / owning a mistake) — fixing the
  prior bug where an agent-phase fire read the user message instead. De-duplication is deliberately
  not done (a repeated fact is an importance signal; consolidation is dream-time's concern).

- **cognition** — `dream_time`'s ranker and merger now resolve their OWN provider pins
  independently (`dreamRankerProvider` / `dreamMergerProvider`, `cognition_config`) rather than
  inheriting the calling turn's provider; unpinned, each still falls back to the turn's own model,
  so nothing needs configuring to get started. Matters most for the merger, which sees a whole
  skill's prose plus the fact and so can truncate/fail on a small-context provider that ranks fine
  (ranking only ever sees short summaries). A durable merge failure (unparseable response,
  truncation, the merger's own length-guard) now quarantines the culprit fact via a new
  `DREAM_SKILL_ERROR` sentinel rather than leaving it stuck for an automatic retry that would just
  fail identically. A fact that scores `none` gets one extra provenance-enriched re-rank — up to 3
  preceding session messages prepended for disambiguation — before being retired permanently (a
  bare atomic fact can under-score in isolation but route cleanly once the conversation that
  produced it is visible); `DreamRun.enriched` records when this happened. A fact that scores only
  `weak` is now **deferred** rather than retired: a new `RememberedFact.ignoreUntil` timestamp
  (governed by `DreamSettings.weakDeferralMs`, default 36 hours) excludes it from selection without
  marking it terminal, since the skill landscape can still change (a skill grows into a fit, or a
  new one is minted from a cluster of similarly-homeless facts).

- **cognition** — `cognition_config` now also exposes dream-time's tunable thresholds
  (`strongThreshold`, `weakThreshold`, `maxClusterSize`, `blocklist`, `weakDeferralMs` — previously
  only reachable via a direct, non-tool `services.settings().set('dream-time', …)` call) alongside
  the three existing provider pins, as one consolidated `CognitionConfig` type. `get` returns the
  effective settings — defaults already merged in for every key — so a single call teaches the
  object's shape as well as its current values. `set` takes a flat partial patch instead of one
  setting per call: an omitted key is left unchanged, a key given as `null` resets it to default
  (or unpins a provider); validation runs over the whole patch before anything is written, so an
  invalid combination (e.g. `weakThreshold` > `strongThreshold`, an unconfigured provider name)
  rejects the call without persisting a partial change. `clear` now takes no parameters and resets
  every setting to its default in one call.

- **frontend/web** — skill editor's Triggers tab rewired to the triggers store: it finds
  the skill's use-trigger via `trigger_action query` and edits that trigger's conditions
  (a wholesale replace on save). Each condition is a `kind` (`augment`/`retract`/`followup`)
  + rule, defaulting new rows to `augment` (the user-message routing case). The tab also
  has a **Suspend** toggle that keeps the trigger and its conditions but stops it firing —
  applied on save via the new `trigger_action` `disable`/`enable` actions. It reflects the
  trigger's `enabled` state on open (suspended only when every matching trigger is disabled).

- **frontend/web** — a `matbot-retraction` marker now drops the superseded assistant
  response from the live thread (matching the post-refresh state, where it's popped from
  the session) and renders as a collapsed, thinking-styled "Retraction" block holding
  only the final text of the retracted turn (no thinking/tool blocks). Assistant response
  wraps are tagged with their `traceId` so the live removal can target the right one.

- **frontend/web** — the **skills and plugins panels now update live**. Two new SSE streams —
  `GET /events/tools` (tool-registry CRUD) and `GET /events/plugins` (plugin load/unload),
  surfaced on both transports as `toolEvents()`/`pluginEvents()` — drive the client to refresh
  skills on `tool-changed` and plugins on `plugin-changed`. Fixes panels going stale when a plugin
  loads out of band (e.g. the Google Drive backend restoring its synced plugin set at boot, after
  the UI's one-shot loads). The plugin stream also catches tool-less plugins (pure
  provider/hook/storage) the tool stream can't see, **retiring the old poll-on-`plugin`-tool-success
  refresh** (which also fired on no-op `list`/`discover_local` calls). **All SSE endpoints moved
  under a `/events/` prefix** (`/events/sessions`, `/events/sessions/:id`, `/events/files`,
  `/events/files/:ns/:name`, `/events/tools`, `/events/plugins`) so no author-controlled path
  segment can shadow a route — a tool named `events` no longer collides with `POST /tools/:name`.

- **providers/openai-compat** — assistant messages with tool calls but no text are now sent
  with `content` **omitted** rather than `content: null` (the spec makes `content` optional
  once `tool_calls` is present, and stricter validators — e.g. gpt-5.x — reject
  `"content": null` with "expected a string, got null"). A tool result whose tool yielded no
  value (e.g. `remember_fact`, which yields only a marker) now serializes as `"null"` rather
  than `JSON.stringify(undefined)` → `undefined`. Both surface when the model invokes a
  no-result tool (a bare tool-call turn plus an empty tool result).

- **providers/anthropic** — a tool result whose tool yielded no value now serializes as
  `"null"` rather than `undefined` (a `tool_result` block must carry content). The assistant
  null-content case does not arise here (tool calls are `tool_use` content blocks, and an
  empty-content message is dropped).
