# @matatbread/matbot-core

## 0.3.6

### Patch Changes

- `instantiateProvider` resolves a provider's adapter by canonical plugin name before force-loading it.
  The factory registry is keyed by canonical name, but the specifier→name fallback only matched the exact
  literal string a plugin was loaded with, so two profiles naming one adapter by different specifiers (a
  yaml path and the package name) missed each other: whichever was used first registered the plugin, and
  the second force-loaded it again, threw "already registered", and surfaced as
  `provider "…" has no loadable adapter`. Stored profiles are still never rewritten.

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

- Updated dependencies [3e662d0]
- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5

## 0.3.4

### Patch Changes

- c3a1b00: New branded `ReadOnlyError` (`readOnlyError()` factory + `isReadOnlyError()` guard, alongside the other
  brand-based typed errors) for a `Store` write rejected because the current principal does not own the
  item — e.g. a session shared read-only from another profile's partition.

  The turn pump now catches it around the persist-at-turn-start write in `SessionRunner`: a read-only
  rejection is surfaced as a per-turn `error` event and the submission is dropped, instead of escaping the
  detached pump and crashing the host. Any other write failure stays fatal as before. Detection uses the
  brand guard, never `instanceof`, so it holds across a skewed/duplicated plugin-api install.

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4

## 0.3.3

### Patch Changes

- Native Google Gemini provider + provider-agnostic round-trip metadata.

  - New `@matatbread/matbot-provider-google`: one `module:`, two wire formats chosen by endpoint path — native `generateContent` adapter, or the openai-compat adapter in `gemini` mode. Thought-signature round-trip, foreign/unsignable tool calls degraded to text context notes (not elided), and tool schemas sanitized to Gemini's strict OpenAPI subset.
  - `plugin-api`/`core`: replaced the tool-call `signature?: string` with an augmentable `meta?: ProviderMeta`. Providers declare their own namespaced slice from their own module, so core carries round-trip metadata opaquely and never changes when a provider adds its own.
  - `openai-compat`: opt-in `gemini` mode (thought-signature round-trip via `extra_content.google.thought_signature` + foreign-call degradation); homes the `ProviderMeta.google` augmentation.
  - `tool-router`: order the working set by adoption (first-seen) so it grows append-only, keeping the tools prefix byte-stable for prompt caching.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2

## 0.2.9

### Patch Changes

- frontend/telegram: fix a boot crash (`No provider registered for module "…". Available: none`) that unloaded the plugin at startup. It eagerly built a provider adapter in `setup()` via the removed `resolveProviderFactory(config.module)`, but with the pre-scan disabled no factory is registered yet. The frontend now holds only the active provider name and lets the runner resolve the adapter per turn via `complete()` → `instantiateProvider`. Also removes the dead `resolveProviderFactory` export from core.
  - @matatbread/matbot-plugin-api@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8

## 0.2.7

### Patch Changes

- Release 0.2.7
  - @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6

## 0.2.4

### Patch Changes

- Release: web_user_environment + compact_sessions tools, triggers reworked to fire tools with the user/agent × ephemeral/durable orthogonality, quiescent-edge registry application, google-drive storage backend, durable screen context / retractAndRerun, persisted token usage, plus the npm-publishing restructure and assorted fixes. See CHANGELOG.md.
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

- b40c2ec: fix(core/config): tolerate empty `plugins:` / `providers:` sections

  A bare `plugins:` (or `providers:`) key with no entries parses to YAML `null`,
  which the loader rejected with `"plugins" must be a sequence (list)`. This is the
  state `plugin remove` leaves behind when it deletes the last list item, so a config
  that had every plugin removed failed to boot. An empty/null section now reads as
  empty.

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
