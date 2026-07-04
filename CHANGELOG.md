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
- **telegram** — a sub-agent now runs send-only (skips `getUpdates` polling, so its long-poll can't
  409-conflict with the foreground owner's), while still having a live `setup()` so it can send. The
  foreground bot polls as before.
- Plugin bug fixes: **background** correctly sets `allowed` on writes with a clearer
  HTTP error on disallowed; **frontend/web** send/stop button state on session switch
  + initial-message echo; mangled robo message; tool-store type-extraction regex;
  absolute path leak in workspace list.
