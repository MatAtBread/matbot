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

### Optional

- **providers/openai-compat** — opt-in prompt caching. With `parameters.promptCache: true`,
  the adapter sends Anthropic-style `cache_control: {type:'ephemeral'}` breakpoints on the system
  prefix, the tool defs, and the second-to-last user turn (mirroring the native anthropic adapter),
  and reads `usage.prompt_tokens_details.cached_tokens` back as `cacheReadTokens`. Unlocks prompt
  caching for Anthropic/Gemini/Qwen routed via OpenRouter (and surfaces OpenAI/DeepSeek automatic
  caching). Default off — a plain OpenAI or local (ollama/vLLM) endpoint never receives
  `cache_control`, so the flat OpenAI wire shape is unchanged.

- **frontend/web** — queued-message UI no longer folds a quickly-queued message into
  the wrong bubble: only a head still waiting behind a running turn (`queued > 0`)
  opens a foldable batch; a head that runs immediately (`queued === 0`) is sealed
  synchronously by `pump`, fixing the live/reload rendering mismatch.

## Previously

### API gaps filled

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

- **Throwing hooks are isolated, not fatal.** The dispatcher now catches a handler
  that throws, logs it, and treats it as a no-op on every channel — fixing a hard
  failure where a `screen` hook calling a misconfigured provider (unresolved secret)
  threw at the top of every turn, killing the loop with no in-chat recovery.
  Intentional stops remain return values (`abort`/`rejectTool`), never throws.

### Optional

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
