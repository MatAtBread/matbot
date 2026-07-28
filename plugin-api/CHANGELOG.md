# @matatbread/matbot-plugin-api

## 0.3.5

### Patch Changes

- 3e662d0: Mid-turn steering: a submission arriving while a turn runs can now **interrupt** it.

  - **API gaps filled.** `SubmitOpenOpts` gains `mode: 'queue' | 'interrupt' | 'auto'` (default `queue`,
    backward-compatible). `interrupt` stops the running turn — keeping its committed partial work (the
    agentic loop already commits coherently on abort, so no dangling tool-call) — and runs the new
    message next with a "keep going, noting the above" nudge, rather than waiting for the turn boundary.
    The decision is made inside the runner, synchronously against the running state, so an interrupt can
    never land on a later turn.
  - **New optional service `SteeringPolicy`** (`MatbotServices`): under `mode: 'auto'`, its `classify`
    (regex / semantic / LLM — not assumed to be an LLM) decides queue vs interrupt; its `nudge` supplies
    the continuation nudge. Both members optional; absent ⇒ host defaults (`DEFAULT_STEERING_POLICY`,
    `interrupt`, and a built-in nudge).
  - **New `PipelineEvent` variant `steer`** — announces an interrupt so a frontend places the new bubble
    and reads the imminent `aborted` (reason `'steer'`) as a yield, not a dead-end.
  - **Interrupted tool results are reframed.** A tool that errors while the turn is aborted (a steer, a
    cancel) no longer leaks the raw abort reason (`"Error: steer"`) into its result — the runner records a
    neutral "interrupted before completion" message, so a steer's continuation turn reads a clear signal
    and doesn't reflexively re-run a side-effecting tool.
  - **Optional (frontend/web).** `POST /sessions/:id/submit` accepts `mode`, defaulting to `auto` — the
    web frontend opts into steering (interrupt-by-default with no policy registered). Other frontends are
    unchanged (runner default `queue`). The web UI renders the `steer` event as its user bubble live, and
    no longer re-renders the session from the interrupted turn's `aborted` snapshot (which lacked the
    not-yet-persisted steer message and wiped the live bubble until a manual refresh).

- Screen-phase classifier racing: a `screen` hook can race a verdict against the turn instead of gating the first token on it.

  - **API gaps filled.** `ScreenResult.deferred` — a new `DeferredScreen { claim(): DeferredCorrection | undefined }`
    lets a `screen` hook start expensive work (e.g. a classifier judging the user message) concurrently and
    return immediately, handing the runner a poll handle instead of blocking. The runner polls `claim()` —
    synchronously, never awaited — before each provider call, on every stream event, and just before commit;
    the first time it returns a correction, the runner **discards the uncommitted in-progress response and
    re-runs the loop with the correction folded in** (an in-situ redo: no store pop, no retraction marker).
    The mid-stream poll runs before each event is emitted, so a verdict faster than time-to-first-token is
    caught before any token reaches the frontend; a slower one aborts the in-flight provider request (a
    per-call `AbortController` linked to the turn signal) to stop backend generation. `claim()` is
    exactly-once, so a hook coordinates the in-situ path with its own post-commit fallback.
  - **`DeferredCorrection { ephemeral?, durable? }` and `FollowupResult.retractAndRerun.durable`.** A claimed
    correction — and a post-commit retract — can carry `durable` blocks folded onto the turn's user message
    (persisted, `origin: 'robo'`, carried live as a `robo-user` event) as well as, or instead of, `ephemeral`
    tail-fold blocks, so a durable-context correction keeps its persistence even when the verdict lands
    mid-turn or post-commit. `retractAndRerun.context` is correspondingly optional.
  - **Optional (triggers).** The user-phase classifier now races the turn instead of blocking the first token:
    `screen` kicks off classify+dispatch concurrently and hands the runner a `DeferredScreen`, and the
    correction is delivered on whichever path wins — a pre-first-token grace inject, the runner's in-situ
    restart, or the post-commit `followup` retract (`contextual` fires fold durably, `ephemeral` fires
    tail-fold, on all three). This removes the classifier round-trip from the critical path of the ~90% of
    turns where nothing fires. New `classifierGraceMs` setting (default `0`): `0` is a pure race (no added
    latency); a positive value holds the first token up to that long so a fast classifier injects cleanly
    before generation — one knob spanning fully-responsive to fully-clean. Raced verdicts are traced by a
    `user-insitu-fired` (clean path) or `user-retract-fired` (post-commit) marker.

## 0.3.4

### Patch Changes

- c3a1b00: New branded `ReadOnlyError` (`readOnlyError()` factory + `isReadOnlyError()` guard, alongside the other
  brand-based typed errors) for a `Store` write rejected because the current principal does not own the
  item — e.g. a session shared read-only from another profile's partition.

  The turn pump now catches it around the persist-at-turn-start write in `SessionRunner`: a read-only
  rejection is surfaced as a per-turn `error` event and the submission is dropped, instead of escaping the
  detached pump and crashing the host. Any other write failure stays fatal as before. Detection uses the
  brand guard, never `instanceof`, so it holds across a skewed/duplicated plugin-api install.

## 0.3.3

### Patch Changes

- Native Google Gemini provider + provider-agnostic round-trip metadata.

  - New `@matatbread/matbot-provider-google`: one `module:`, two wire formats chosen by endpoint path — native `generateContent` adapter, or the openai-compat adapter in `gemini` mode. Thought-signature round-trip, foreign/unsignable tool calls degraded to text context notes (not elided), and tool schemas sanitized to Gemini's strict OpenAPI subset.
  - `plugin-api`/`core`: replaced the tool-call `signature?: string` with an augmentable `meta?: ProviderMeta`. Providers declare their own namespaced slice from their own module, so core carries round-trip metadata opaquely and never changes when a provider adds its own.
  - `openai-compat`: opt-in `gemini` mode (thought-signature round-trip via `extra_content.google.thought_signature` + foreign-call degradation); homes the `ProviderMeta.google` augmentation.
  - `tool-router`: order the working set by adoption (first-seen) so it grows append-only, keeping the tools prefix byte-stable for prompt caching.

## 0.3.2

### Patch Changes

- Typed, self-repairing codegen pipeline: ToolProxy trailing catch-all overload (sound `ReturnType`, better bad-call errors, dynamic union dispatch); one worker-hosted checker in tool-types with annotated diagnostics and a structural cast gate (no main-thread block, no fallback); skills_compiler embeds the tool-contract dts in every prompt, threads the interactive prompt channel into demonstrations, distils honestly, verifies installs, and repairs over 4 passes; function-tools enforces lambda's one-argument convention.

## 0.2.9

## 0.2.8

### Patch Changes

- Patch release.

## 0.2.7

## 0.2.6

### Patch Changes

- Thread the `ToolEvent<Result>` generic through the producer side and add per-call result discrimination for multi-action tools. `ToolExecutor<R>` / `Tool<R>` now carry the result type at the source; a tool declares it once by augmenting `ToolContracts` (the executor binds via `ToolExecutor<ToolResultOf<'name'>>`, so the two can't drift). Multi-action tools register a union of `ToolContract<Result, Args>` arms, and `invokeTool` narrows the result by the params it's called with. Type-level only — no behaviour change.

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

## 0.1.8

### Patch Changes

- 4891bf7: fix: prevent (and survive) duplicate plugin-api/core copies splitting the principal carrier

  Two layers of fix for the "No PrincipalCarrier installed" failure seen when a published
  install ends up with two physical copies of the host singletons:

  - **Caret dependency ranges.** Inter-package and peer deps were published as exact pins
    (`workspace:*` → `0.1.7`), so any version skew (e.g. an in-place CLI upgrade over an older
    tree) forced npm to nest a second copy of `plugin-api`/`core` — which `npm dedupe` cannot
    merge across exact-but-different requirements. They now publish as caret (`workspace:^` →
    `^0.1.7`), so a single highest copy satisfies the whole tree.

  - **Process-global principal carrier.** The carrier was a module-level `let`, so two copies of
    `plugin-api` each had their own — the host installed into one, a plugin read the other, and
    every principal read threw. It now lives on `globalThis` under `Symbol.for(...)`, so all
    copies share the single carrier the host installs at boot. Deduping is still preferred; this
    makes duplication harmless rather than fatal.

## 0.1.7

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.1.1
