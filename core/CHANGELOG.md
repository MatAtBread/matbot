# @matatbread/matbot-core

## 0.4.0

### Minor Changes

- Two turn-loop bug fixes, plus the plugin-api 0.4.0 surface changes re-exported.

  **Bug fixes**

  - A provider call that fails mid-turn now commits the rounds that succeeded. Nothing is written mid-turn,
    so the failed-call exit returning without a commit discarded the whole turn — and the multi-round case
    is the tool-using one, so an upstream 500 on round 3 lost two completed rounds of assistant messages and
    tool results the frontend had already drawn.
  - A plugin's `services.mounted` interests are dropped on unload. The only cleanup path was an aborted
    `signal`, which is optional, so a plugin that omitted it left a live handler firing into a torn-down
    closure — one more per reload generation, silently.
  - A tool-name collision can no longer crash the process or revive an unloaded plugin's tool: the
    collision branch is the one `await` in `registerTool` with no caller to own its outcome, so a throw
    there was an unhandled rejection, and a slow resolution could land after an unload.
  - `teardownPlugins` named the wrong plugin in its error log (reversed list, unreversed index).

  **Breaking**

  - The duplicate `ProviderRegistry` declared in `core/src/types.ts` is gone. It shadowed plugin-api's via
    `export type *`, so `import type { ProviderRegistry } from '@matatbread/matbot-core'` silently resolved
    to the adapter registry rather than the `ProviderConfig` map. Nothing imported it.
  - Core re-exports plugin-api's `/host` subpath in full, so hosts need no change for that move. Every
    branded error is now re-exported, including the previously-missing `readOnlyError`/`isReadOnlyError`.
  - The pre-Store flat-settings migration is dropped; an unrecognised settings document is treated as
    absent. Every `settings.get()` had been paying for the check.
  - `runSession` yields `TurnEvent` rather than `PipelineEvent` — a turn never emits the session-level
    `idle`.

## 0.3.10

### Patch Changes

- Tool media, per-provider round ceiling, and recovery from a truncated tool call.

  - `model-content` ToolEvent: a tool can hand the model an image, PDF or audio clip to look at. Pinned
    after the tool message it answers, carried for the rest of the turn, never persisted.
  - `document` converts natively for Anthropic (base64 PDF, decoded `text/*`) and Gemini (`inlineData`,
    which also covers audio) instead of degrading to a text placeholder in every adapter.
  - `ProviderConfig.maxRounds`: a per-profile ceiling on tool rounds per turn. Replaces the removed
    `ProviderConfig.fallback`, which was declared, parsed, and read by nothing.
  - A tool call cut off mid-arguments is answered with an error result instead of throwing, so the model
    self-corrects; a response cut short is recorded as an LLM-invisible `matbot-truncation` marker.
  - Fixes: `complete()` folds usage events instead of last-event-wins; `followup` no longer runs after an
    aborted or errored turn; a `toolcall` abort commits the turn; `FilesystemStore` escapes store ids
    that are not filename-safe rather than rejecting them; the anthropic adapter no longer emits adjacent
    same-role messages; openai-compat terminates a stream with exactly one `done`.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.9

## 0.3.8

### Patch Changes

- **`StoreQuery.immutable` is accepted by the query validator**, and `ItemChangeKind` /
  `RegistryChangeKind` are re-exported from `@matatbread/matbot-core` alongside `createNotifier`,
  `scopedNotifier` and `notifyingStore`, so a plugin linking only against core gets the renameable
  handles without reaching into `plugin-api`.

- Notification bus: one swappable service carrying every "something changed" fact.

  Five unrelated mechanisms used to tell a frontend something had changed — two core registry
  broadcasters, the SkillManager's own broadcaster, the file store's `fs.watch`, and a frontend-local
  busy broadcast — each with its own payload shape, its own SSE event name, and its own client
  plumbing in both transports. Adding a sixth kind meant editing four files, and several changes had
  no channel at all: a session created in one browser never appeared in another, a first share or an
  unshare never reached the sharee's list, and file deletions were structurally unrepresentable
  (`FileEvent` has no operation, and the filesystem watch drops them).

  - **`Notifier`** (`MatbotServices`, swappable, host boot default): `notify` / `subscribe` / `consume`
    over one `Notification` envelope. Within a plugin's `setup()` it is scoped, so published
    notifications carry that plugin's name.
  - **The envelope** discriminates on `kind` (the shape — `ItemChange`, `RegistryChange`, or an
    augmentation) _and_ carries attribution (`instance` / `plugin` / `source`) as separate fields, so a
    sink can filter on either or both. `principal` — whose data it is — stays distinct from
    attribution: it is what `WatchVisibility.visible` consumes. `kind` is **open at runtime**, so a
    `switch` over it must always have a `default`.
  - **A `kind` is `<package-name>#<InterfaceName>`** — `'@matatbread/matbot-plugin-api#ItemChange'`,
    `'@matatbread/matbot-plugin-api#RegistryChange'`. A `kind` is globally scoped and, unlike a type
    name, an importer cannot rename it out of a collision: two plugins picking the same bare word is an
    unfixable declaration-merge conflict in `Notifications`, and across a bridge a silent
    mis-narrowing. The package name — already unique — qualifies it, and names the package that
    _defines_ the shape, never the one emitting it (`plugin` is the emitter; four plugins emit
    `ItemChange`). `ItemChangeKind` / `RegistryChangeKind` are exported so consumers get a renameable
    handle back. An arm never declares `kind` itself: `NotificationBase` has no such field and
    `Notification` grafts each arm's `Notifications` key on, so the tag cannot disagree with the key it
    is registered under. `NotifyInput` rejects an unqualified key at the `notify` call, and
    `createNotifier` warns at runtime for producers TypeScript never saw (plain JS, a bridge).
  - **Identity, never value.** An `ItemChange` carries `namespace`/`id`/`operation`; `detail` is
    explicitly advisory. Consumers re-read through the store — an event is invalidation, not state. No
    persistence or replay: a sink re-queries on attach.
  - **New notifications**: every write to the `sessions` namespace (create, the turn pump's title
    derivation and persists, `session_action` rename/hide/unhide, `session_edit` fork/split) via a
    `notifyingStore` wrapper on that one store — the namespace has many writers, so one wrapper beats an
    explicit notify at each and cannot be forgotten by the next writer; `share` /
    `unshare` / `copy` landing in a profile (they mutate a partition's visible set without passing
    through a Store or the file watch, so nothing else could see them); a `background` job's captured
    output file completing.
  - **Distributed left open, not built**: an implementation registered over `Notifier` may forward
    off-box; `instance` is stamped on ingress and is the loop break. Nothing in core assumes one server.

  Two fixes the live list surfaced, both about an affordance that was previously unreachable:

  - **Deleting a shared-in item un-shares it.** The profiles backend now routes a `Store.delete` (and a
    `FileStore.delete`) of an item shared INTO the current partition through its own `unshare` path, instead
    of relying on the raw unlink happening to spare the owner's file: the shared-in cache is updated and the
    change is announced, where before both were stranded. No API changes — a delete is a delete to the
    caller, which may not have profiles loaded at all; only this layer can tell the two apart. The web
    session list's `×` on a shared-in session unshares rather than archiving it (an archive is a write, and
    raised `ReadOnlyError`); rename is withheld there for the same reason.
  - **An interactive prompt answered in another browser.** `prompt-resolved` is emitted on the session
    stream from the settle path every answer, cancel and abort funnels through, and the web UI retires a
    dialog on it. The UI's prompt case no longer _awaits_ the answer inside the turn's event loop: parking
    there stalled every later event of that turn in the other browsers — including the `prompt-resolved`
    that would have retired their dialog.

  The web frontend now consumes one `notification` SSE stream in place of `file-changed` /
  `skill-changed` / `tool-changed` / `plugin-changed`, with matching in-process wiring in the browser
  transport, and re-lists sessions live.

  **Breaking: `ToolRegistry.watch()` and `watchPlugins()` are removed**, along with
  `ToolRegistryEvent` and `PluginRegistryEvent`. Both registries were broadcasters over the same
  primitive the bus is, so keeping them was duplication rather than layering: they now publish a
  `RegistryChange` with `registry: 'tools' | 'plugins'` and consumers subscribe to the bus. `tools`
  notifications carry the registering plugin's name in the advisory `detail` (resolve the name for
  anything authoritative). Ported: `tool-router`, `tool-types`, the frontend's tool-resolve boot-grace
  wait, and the two bridges the frontend used to run. `SkillManager.watch()` went the same way.

  **Breaking: `FileStore.watch()` is removed**, with `FileEvent` and `WatchVisibility.watchFiles`.
  It existed to detect writes made outside matbot — but matbot writes `.data` and nothing else, and
  every in-process writer now announces itself, so no first-party feature depended on it. As a core
  interface it was actively misleading: only the filesystem store implemented it, sqlite re-broadcast
  its own writes (which the bus already carries), and Drive and OPFS returned a stream that yields
  nothing — making "this backend cannot watch" indistinguishable from "nothing has changed". Watching
  arbitrary filesystem activity is a plugin's job: it can watch whatever it likes and publish onto the
  bus, which any sink already understands. `GET /events/files/:ns/:name` goes with it (no first-party
  consumer); `/events` still carries every file notification. `WatchVisibility` keeps `visible()` — the
  part that was ever a contract rather than a transport.

  One channel deliberately remains outside the bus: `session-busy` is transient state replayed on
  connect, which the bus does not carry by design.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.7

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
