# Changelog

All notable functional changes are documented here. Purely stylistic or
non-functional changes (CSS, refactoring, code tidying, docs-only merges) are
omitted.

Within each section, changes are grouped: **Breaking changes**, **API gaps
filled**, and **Bug fixes** cover `core` (the contract consumers depend on);
**Optional** covers new or updated plugins, frontends, and apps — more likely to
churn and less likely to affect a consumer who doesn't use them.

## Unreleased

### Breaking changes

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
  + rule, defaulting new rows to `augment` (the user-message routing case).

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

## Previously

### Breaking changes

- **`StoreQuery` redesigned as a minimal, backend-translatable grammar.** The
  previous query type was an unfinished superset (filter/fullText/vector/sort-with-magic-fields/
  offset/projection/explain) that every backend "implemented" by loading all rows
  and filtering in JS. It is replaced by a small closed grammar where every
  construct maps natively to SQL/Elasticsearch/Mongo/IndexedDB. Consumer-visible
  consequences:
  - `Filter` is now a closed union discriminated by `op`
    (`eq`/`neq`, `lt`/`lte`/`gt`/`gte`, `in`/`nin`, `exists`, `stringContains`,
    `arrayContains`, `and`/`or`/`not`).
  - `FieldPath = string | string[]` — a bare string is **one** key (no longer split
    on `.`); use an array for nested paths.
  - `StoreQuery` is no longer generic; `QueryResult<T>` now has flat `items: T[]`
    plus optional `cursor`/`total`. All callers (background, sessions, skills,
    frontend/dom, persist-ki-bge, tool-store) migrated to the flat shape.
  - Comparisons are type-strict (`5 ≠ "5"`); `null` and absent collapse to a single
    "missing" state observable only via `exists`.
  - Invalid queries throw a located `StoreQueryError` (JSON pointer + code) at the
    boundary instead of silently mis-matching.
  - Full-text/vector search, field-vs-field comparison, and regex are intentionally
    removed from `Store` (they live on `KnowledgeIndex`/future interfaces).

### API gaps filled

- **The `Vault` backend is now swappable at runtime via `services.register('Vault', impl)`.**
  Storage and knowledge were already replaceable behind a capture-safe forwarding
  proxy, but the vault was the one core backend a plugin could not replace. Filled
  by wrapping the active vault in the same `forwardingProxy` over a mutable
  `activeVault`, adding a `register('Vault', …)` branch that re-points it, and
  exposing a `Vault?` swap-handle key on `MatbotServices` (the read path stays
  `services.vault`). References captured before a swap keep resolving to the live
  impl. This enables, e.g., an encrypted per-user DB-backed secret store in place of
  `.env`.
- **`MemoryStore` (apps/cli) now honours queries.** It previously ignored them; it
  now delegates to the shared `executeQuery` reference engine like the other
  in-memory backends.
- **`singleTurn` promoted to a first-class `MatbotServices` method** (alongside
  `complete()`), implemented in both hosts (cli, web-bundle) as a thin delegation to
  their own `complete()`. The pure, platform-independent helpers (`forwardingProxy`,
  `makeSwappable`, `SwapFn`, `singleTurnRequest`) moved into plugin-api; the skills
  plugin now calls `services.singleTurn(...)`.
- **`services.isSubAgent`** added to the plugin-api.
- **Initiating provider passed through to tools** (e.g. `background`) via a new field
  on the tool-execution context.
- **Tool listing now returns tool names & descriptions** (core `tool-plugin`, plus
  the browser plugin-tool).
- **Hook self-removal: every hook `ctx` now carries `removeHook()`**, which
  unregisters the currently-running hook — the clean one-shot primitive (no plugin
  name, no `removeByPlugin`).
- **Hook-failure visibility:** a throwing hook is recorded (deduped by identity) and
  drained into a `matbot-hooks` marker by the next `runScreen`; a new `marker`
  `PipelineEvent` carries it live. The `SkillManager` service key was added to the
  `MatbotServices` augmentation.

### Bug fixes

- **`plugin reload` now actually re-evaluates plugin code from disk.** Two stacked
  regressions: (1) the cache-bust stamp (`?mbfresh`) was silently bypassed because
  the node host always pre-populated `importSpec` with an absolute `file://` URL, so
  Node re-served the cached module — fixed with `freshImportSpec()`, which stamps a
  pre-resolved `file:` URL while leaving `blob:`/other schemes untouched; (2) tool
  executors were resolved from a turn-start registry snapshot, so a reload performed
  mid-turn didn't affect later tool calls in that same turn — fixed by resolving the
  executor against a live `toolRegistry` at call time (the snapshot remains the
  stable tool list advertised to the model, preserving prompt caching). A tool
  removed mid-turn now correctly resolves to "Unknown tool".
- **`StoreQuery` paging no longer overlaps.** Cursors are now opaque, stateless and
  self-contained (carrying `{where, sort, limit, offset}`), and sort always appends
  `id` as a final tiebreaker. Previously the cursor held only an offset, so page 2
  sent without a sort fell back to id-order and overlapped page 1.
- **Throwing hooks are isolated, not fatal.** The dispatcher now catches a handler
  that throws, logs it, and treats it as a no-op on every channel — fixing a hard
  failure where a `screen` hook calling a misconfigured provider (unresolved secret)
  threw at the top of every turn, killing the loop with no in-chat recovery.
  Intentional stops remain return values (`abort`/`rejectTool`), never throws.

### Optional

- **frontend/web** — queued-message UI no longer folds a quickly-queued message into
  the wrong bubble: only a head still waiting behind a running turn (`queued > 0`)
  opens a foldable batch; a head that runs immediately (`queued === 0`) is sealed
  synchronously by `pump`, fixing the live/reload rendering mismatch.
- **cognition** (new plugin) — `@matatbread/matbot-cognition`, a consumer of the
  skills service that seeds built-in skills (Inner voice, Remember this, Dream-time)
  create-if-absent, discovering the live `SkillManager` off the registry and
  degrading gracefully (deferred one-shot screen hook) when none is present yet.
- **tool-store** (new plugin) added.
- **skills** — now registers the `SkillManager` service (idempotent / double-setup
  safe); trigger classifier reworked so the opposing prior turn is a first-class
  input (relational triggers can use it); agent-phase robo resubmit names matched
  skills instead of inlining full content, so history no longer accumulates whole
  playbooks on every fire.
- **frontend/web** & **CLI** — render the new `matbot-hooks` marker live and on
  reload (amber warning pill / amber ⚠ line).
- **telegram** — no longer polls in the background.
- Plugin bug fixes: **background** correctly sets `allowed` on writes with a clearer
  HTTP error on disallowed; **frontend/web** send/stop button state on session switch
  + initial-message echo; mangled robo message; tool-store type-extraction regex;
  absolute path leak in workspace list.
