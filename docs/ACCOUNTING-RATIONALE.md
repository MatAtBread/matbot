# Why accounting is shaped this way (the rationale)

This is the *why* behind the usage/accounting model — the turn bag, the attribution coordinate, and
where normalisation belongs. The mechanics belong in `CLAUDE.md` and `docs/DEVELOPING.md`; this is the
motivation, so the design isn't re-litigated from scratch.

Raised by [issue #38](https://github.com/MatAtBread/matbot/issues/38): accounting was the one part of
the persisted model with no extension point.

## The origin problem

`Usage` was five fixed slots — `inputTokens`, `outputTokens`, `costUsd?`, `cacheReadTokens?`,
`cacheCreationTokens?` — a **closed** target, so every adapter had to normalise *destructively* to hit
it. The fault is the closed target, not the normalising; an adapter mapping its protocol's vocabulary
is exactly the right party doing exactly the right job, and it only became lossy because there was
nowhere to put what did not fit:

- anthropic mapped `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` straight
  across, flattening the 5-minute and 1-hour cache-write tiers (priced differently) into one number;
- openai-compat computed `inputTokens = prompt_tokens - cached_tokens`, deliberately re-interpreting
  the endpoint's own figure so it would mean the same thing as anthropic's;
- google folded `thoughtsTokenCount` into `outputTokens`, erasing a distinct billing category.

Four consequences followed, and they are the whole motivation:

1. **`costUsd` was dead by construction.** It was declared, summed by `addUsage`, and rendered by the
   CLI — and no adapter ever populated it. Not an oversight: a rate table *cannot* be correct when
   keyed on slots that have already discarded the tier, the modality and the reasoning split. The type
   existed; the information it needed did not.
2. **Figures could not be reconciled.** `inputTokens` no longer equalled `prompt_tokens`, so a matbot
   total and a vendor dashboard disagreed with no way to explain the difference.
3. **Duration was measured and thrown away.** The runner timed each tool call, handed `durationMs` to
   the `toolresult` hook, and persisted nothing. A consumer had to re-derive it, worse, from event
   arrival times. The provider call was never timed at all.
4. **Out-of-band spend was dropped or, worse, misfiled.** `withUsageScope` wrapped the whole turn but
   the sink was only ever drained by slicing per tool call. A completion run from a hook — the triggers
   classifier, a router, an auto-compaction — appended a record that nothing read. And because the
   triggers classifier is *detached* (kicked off in `screen`, awaited later), whether its spend vanished
   or landed on whichever tool happened to be running was decided by a race.

So consumers kept parallel accounting records: their own event log per turn, their own service for
itemising hook-run completions, token figures duplicated alongside `Message.usage`, and an aggregate
that disagreed with the itemisation by construction.

## The line: matbot guarantees fidelity and attribution, not semantics

There are exactly two things only matbot can do.

**Fidelity** — retain what the endpoint actually said, so nothing an adapter interprets is destroyed on
the way past. Note what this is *not*: an argument against normalising. It is an argument against
normalising **over** the original.

That distinction is empirical, not theoretical. Sending one prompt to DeepSeek direct, through its own
Anthropic-compatible endpoint, and through Azure gives a clear hierarchy
(`.data/files/deepseek-azure-vs-direct-api-shape-comparison.md`):

> **Protocol (dominant) > Model (feature richness) > Host (capability ceiling & stripping)**

- **Protocol** fixes the wire shape — `choices[]` vs `content[]`, `prompt_tokens` vs `input_tokens`,
  `finish_reason` vs `stop_reason` — invariant across host and model.
- **Model** decides which optional features exist at all: the reasoning split, cache detail, latency
  telemetry.
- **Host** can only *withhold* within that shape, or add platform extras. Azure returns no
  `reasoning_content` for DeepSeek where the direct endpoint does, and reports a different
  `prompt_tokens` (it injects no jinja template overhead) — but it cannot change the shape.

  One caveat on that last tier, because it matters below: every call in the comparison was a single
  uncached request, so for the cache fields *absent* and *zero* are not distinguishable in that data.
  Azure omitted `prompt_tokens_details` / `prompt_cache_*` entirely where the direct endpoint reported
  them as explicit zeros — a real host-level difference, but not evidence of which one it is. "Strips
  the capability" and "omits when zero" are operationally different: under the second a consumer still
  gets the numbers exactly when they matter. Settling it needs a repeated prefix through Azure, and
  nothing here depends on the answer.

So the earlier worry — that per-deployment vocabulary drift would need its own normalising layer — was
wrong. Azure-DeepSeek and direct DeepSeek speak the *same* protocol with *fewer fields populated*, and
the party that already owns a protocol is the adapter. There is no second vocabulary to learn, and so
no second plugin to write.

What the host variation demands is a discipline: **absent must stay absent, and an explicit zero must
stay an explicit zero.** They are different facts. A missing `prompt_cache_hit_tokens` has at least
three possible causes — the host withholds the capability, the endpoint omits zero-valued keys, or the
call genuinely had no cache activity — and one wire representation for all of them. An adapter that
resolves that ambiguity by writing `cacheReadTokens: 0` has manufactured a measurement, and has
destroyed the very distinction anyone auditing it would need.

matbot already loses this, in the opposite direction and for every provider: all three adapters guard
the cache fields on truthiness (`cached > 0 ? … : {}`), so an endpoint that explicitly reports
`cached_tokens: 0` — as DeepSeek direct does — is recorded identically to one that reported nothing at
all. The question "did this provider tell us there was no cache activity, or tell us nothing?" is
currently unanswerable from a matbot record, whatever the endpoint said.

This is the strongest argument for verbatim retention, and it is stronger than the vocabulary argument
it replaced: retention preserves the present-zero/absent distinction for free, because it never has to
decide. Normalising into a fixed slot cannot preserve it, because a slot has no way to say "the
endpoint didn't tell me" that a consumer can tell apart from "the endpoint said none".

**Attribution** — say *where* in its own control flow a completion happened: which turn, which round,
inside which tool call, from which hook. No adapter and no plugin can recover this. It is the same
category as the principal: a fact about the harness's own execution, not about the endpoint.

Everything past that line is policy — rate tables, what a token costs, what a "task" is, how to group
spend, how to reconcile two deployments of the same model. Those belong to plugins, through
well-defined interfaces.

The test is **non-prevention**: an API that omits the attribution coordinate makes per-tool auditing
impossible for *anyone*, because the fact is unrecoverable after the turn. That is a prevention, and
so the coordinate is intrinsic. A rate table, by contrast, is prevented by nothing.

## Why a log, not a fold

The tempting shape is per-provider totals: `Record<providerName, counters>`. One turn genuinely spans
several providers — a turn submitted to Opus may classify triggers on DeepSeek and invoke a tool that
calls Gemini — so keying by provider is meaningful.

It is also **already an aggregation policy**, and the only opinionated thing in an otherwise neutral
record. It picks one grouping and destroys the others. Four audit axes are wanted in practice:

| Question | Grouping |
|---|---|
| what does this tool cost? | by call-site |
| what does this user cost? | by the bag's principal |
| what does this session cost? | by the bag's session |
| what does this task cost? | by whatever a plugin decides a task is |

All four fall out of one coordinate-tagged log, and matbot learns none of them. Per-provider totals are
then a *derived view* — which is what `usageByProvider` already was. Storing the fold instead of the
log is simultaneously more API surface and less capability.

## The turn is a coordinate, not a container

The obvious model — accumulate a bag per turn, strike a total at the end — does not survive contact
with matbot's own concurrency. Two behaviours break it, and both are ordinary:

1. **A completion can be recorded after its turn commits.** The triggers classifier is kicked off
   detached inside `screen`; a `followup` hook runs post-commit by definition. A total struck at turn
   end is summing a bag still being written to.
2. **A retract-and-rerun relocates spend out of the accounting surface.** The pop stashes the superseded
   messages inside a retraction marker's `data`, and `usageByProvider` walks `m.usage` and `tool-result`
   blocks — never marker payloads. So a retried turn under-reports by exactly the attempt it discarded,
   and recovering it means knowing a marker creator and digging, which is the lookup that putting usage
   on messages existed to abolish.

Neither is fixed by choosing a better boundary, because the boundary is not the problem: *accumulating
to a boundary* is. Steers terminate and resume a loop, triggers race, followups enqueue more work —
"the end of a turn" is genuinely ambiguous, and spend is distributed across processes (main line, tools,
hooks, triggers, steers) that are not sequential with respect to each other.

So the turn is demoted to a coordinate, and totals become **queries** rather than accumulations.

## The shape

An **entry is self-describing**, so nothing depends on where it sits:

- the provider profile billed;
- `reported` (the endpoint's own field names) alongside the normalised counters;
- the **call site** — which round, which tool call, which hook;
- the **causal `traceId`** — the turn that caused it, whenever and wherever it is eventually written.

The ambient scope is then a **buffer, not a record**: it accumulates in flight and is flushed to
storage, never persisted as an object and never addressed. Grouping by turn, tool, user, session or
task is a query over entries — the same one fact set, four questions, none of them core's business.

The minimality cut is inverted from where it looked at first: an entry carries **everything needed to
place it**, precisely because its location is unreliable. Late arrival and retraction both move an entry
away from the thing it describes, so anything inferred from adjacency is wrong sooner or later.

Entries anchor on the **turn head** — the user message — because it is the one message a retract-redo
deliberately keeps (`messages.slice(0, lastUserIdx + 1)`), so anchoring there survives a retraction for
free where an assistant message or a `tool-result` does not. Locality is not lost: `site` already names
the tool call, and physical adjacency never carried information the coordinate doesn't.

The flush point is **pump idle**, not turn end. The queue draining is unambiguous exactly where turn-end
is not — steers, retracts and followup resubmissions all enqueue more work, so `idle` is genuinely after
all of it, and it is already an event the pump emits. An entry still in flight at idle flushes at the
next one, correctly attributed by its own `traceId`. Eventual and ordered is all a log needs to be.

### A consequence for consumers

A per-turn waterfall is not simply a view over this — it is a view over an assumption the runtime does
not honour. Any UI drawing one today shows a total that silently omits retracted attempts and places
detached classifier spend by when it resolved rather than what caused it. That is not a shortcoming of
the model; it is a defect the model makes visible, and the fix is on the presentation side.

matbot's own frontend is no exception, which is the point: `frontend-web` reduces per-turn usage by
`traceId` over an inline copy of `usageByProvider` and renders it as a footer under each turn, so it
under-reports a retried turn exactly as any downstream UI would. What changes for it is small — read
entries off the turn head instead of walking two message shapes — plus one genuinely new behaviour: a
flush at idle can land after the footer is drawn. That needs no new mechanism either, since the flush
is a session write and the sessions store is already wrapped in `notifyingStore`, so the `ItemChange`
the frontend already consumes re-renders it.

### Call sites are a closed set

Inside a turn there are exactly three places a completion can happen — a runner round, a tool executor,
a hook handler — and outside a turn there is no bag, which stays the documented no-op. The coordinate
rides the same ambient carrier as the sink and is pushed where matbot already brackets: around its own
provider call, around `tool.executor.execute(...)` (already bracketed for the duration measurement),
and around each hook handler (`HookRegistry` already holds the channel and `pluginName`).

Because the carrier captures at continuation creation, the detached triggers classifier tags itself
where it *starts* — inside the `screen` hook — and stays correctly attributed however late it resolves.
**Attribution is declared by the producer, never inferred by the runner from a slice window.** That is
what retires the misfiling race: there is no window to fall outside of.

### Sub-turns nest

`withUsageScope` established a fresh, empty sink — it shadowed rather than nested, which was invisible
only because nothing opened a second one. A sub-turn (a tool's `singleTurn`, a consolidation pass) opens
its own bag and rolls up into its parent on exit, so a caller can ask what one sub-turn cost without its
spend disappearing from the turn that contains it. Mappers being pure over `reported` is what makes this
free: children accumulate raw, roll up by key, and mapping runs once at whichever boundary is asked.

## Duration: two measurements, not one

Wall-clock is not a single quantity, and conflating the two is what made "is duration intrinsic?" hard
to answer:

- the **bracket** — how long matbot's own scope was open (a tool call, a round). Only matbot can measure
  it, so it is an entry field.
- the **endpoint measurement** — server-side latency, time-billed units. The adapter owns the `fetch`
  and some endpoints report timing directly, so it belongs in `reported` like any other provider-named
  field.

A tool span is therefore intrinsic; provider latency is reported. Neither is a substitute for the other.

## Normalise for comparability, retain for fidelity

The adapter **is** the normaliser. It is a plugin, there is one per protocol, and the protocol is what
determines the shape — so introducing a separate normaliser interface would add a plugin layer to do a
job the installed plugin already does. It was proposed on a premise the measurements above disproved,
and it is not built.

What the adapter does is **partial** normalisation, against an open target:

- **Normalise the genuinely universal.** Input and output tokens exist unambiguously in every protocol,
  and something must be common or a turn spanning three providers cannot be totalled at all — pushing
  protocol knowledge out to every consumer is strictly worse than the adapter keeping it.
- **Retain the rest verbatim**, under the names the endpoint used, present only when actually reported:
  `reasoning_tokens`, `prompt_cache_hit_tokens`, `cache_creation_input_tokens`, `service_tier`,
  `latency_checkpoint`. An adapter recognising fewer fields degrades to carrying more of them raw —
  never to inventing any.

Retained values are **not all counters**, which is why `reported` is not a `Record<string, number>`.
`service_tier` is a string and prices the call; `latency_checkpoint` is a nested object. Interpreting
them is the whole thing being deferred, so they are carried as they arrived.

The two are not in tension once both are kept. openai-compat reporting
`inputTokens = prompt_tokens - cached_tokens` is a real interpretation — it makes the figure mean what
anthropic's `input_tokens` means, which is what makes cross-provider totals possible — and it stops
being *lossy* the moment `prompt_tokens` and `cached_tokens` ride alongside it. The defect was never
the interpretation. It was performing it destructively, so no consumer could check it, reverse it, or
reconcile the total against a vendor's own dashboard.

That leaves exactly one optional interface: a **mapper**, reading normalised counters + retained raw +
call sites, and populating its own namespaced `meta` slot (cost, performance, quota). Pure over its
inputs and never reading another plugin's slot, so it is order-independent and re-runnable over
historical entries — possible precisely because the raw was retained. One plugin, not a layer cake, and
none needed at all for matbot to keep working.

## Fold rules

- `reported` aggregates **key-wise by sum over numeric values only**, and only across entries from the
  same provider. Non-numeric retained values (`service_tier`, `latency_checkpoint`) are per-call facts
  and are simply not aggregated — a total `service_tier` is meaningless, and a consumer that cares reads
  the entries. Same-provider because the same key means different things under different protocols
  (`prompt_tokens` includes cache hits, `input_tokens` does not), so summing one across providers adds
  unlike quantities. Totals spanning providers use the normalised counters, which exist for that.
- That imposes one obligation on adapters: reported fields must be **per-call absolute, not
  cumulative**. The google adapter already satisfies it by emitting only the final tally, but it was a
  local decision; key-generic summing makes it a contract.
- `meta` is **never folded**. A cost plugin's `usd` adds; a performance plugin's percentile does not.
  Only the plugin knows, so only the plugin aggregates its own slot.

## What deliberately stays outside

Rate tables and prices. Groupings. What a "task" is. Reconciling two deployments of one model.
Distributed aggregation. Retention and rollup policy. All of it is plugin work over a faithful,
attributed record — which is the only thing core promises.

## Implementation order

1. **Attribution coordinate + nesting.** *(landed)* Fixes the misfiling race; stands alone.
2. **Entries carry their cause and anchor on the turn head**, flushed at pump idle. *(landed)*
3. **Open the target**: `reported` alongside the normalised counters, adapters retaining what they
   discard and synthesising nothing. No new plugin — three adapter changes. *(landed)*
4. **Brackets**: tool and round spans as entry fields.
5. **`meta` registry + mapper interface**, once there is something to map.

(1) and (2) are bug fixes and are worth landing regardless of what happens to the rest.
