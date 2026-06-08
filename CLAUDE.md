# matbot — Design Principles

This file is the authoritative guide for anyone (human or LLM) working on this codebase.
Read it before making any structural decisions.

---

## What matbot is

A TypeScript AI harness — a thin, composable runtime that connects language models to tools
and frontends. It is not a product; it is infrastructure.

---

## Hard constraints

### No provider SDKs
All LLM communication is plain HTTP using the web-platform `fetch` API.
Never import `@anthropic-ai/sdk`, `openai`, or any other provider SDK.
Use the HTTP endpoints directly; stream via SSE parsed with `parseSSE` from `@matatbread/matbot-providers-base`.

### No Node-specific primitives in shared packages
Packages under `packages/` (except those explicitly suffixed `-node`) must run in both Node and
the browser. Use web-platform APIs: `fetch`, `crypto.randomUUID()`, `AbortController`,
`AbortSignal`, `TextDecoder`, `ReadableStream`, `SubtleCrypto`. Never use `require`,
`Buffer`, `EventEmitter`, `fs`, `path`, `child_process`, or `os` in shared packages.
Node-only code lives in packages named `*-node` or in `apps/`.

Also avoid `process.env`: it is an anti-pattern in matbot. Secrets and key substitution
go through the `Vault` (`${NAME}` placeholders resolved at runtime against one flat namespace);
all other per-install configuration goes through plugin `Settings`. Both are abstractions
with swappable backends (`.env` is merely the default node `Vault`; the browser build uses
WebCrypto + browser storage and has no `.env` or `matbot.yaml`), so a plugin reaching for
`process.env` directly is not portable. (TODO: enforce with a lint rule once eslint lands.)

### AsyncIterators, not callbacks
Streaming events flow through `AsyncIterable<T>`. Never use `EventEmitter` or raw callbacks
for inter-layer communication. All provider adapters return `AsyncIterable<CompletionEvent>`,
all tool executors return `AsyncIterable<ToolEvent>`, and the runner emits `AsyncIterable<PipelineEvent>`.

### Strict TypeScript everywhere
`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
Consequences:
- Optional fields require conditional spreads: `...(val !== undefined ? { key: val } : {})`
- Array/map indexing returns `T | undefined` — always guard or assert
- `process.exit(1)` does not narrow types unless `@types/node` is loaded; prefer `throw new Error()`
- `switch` exhaustiveness on discriminated unions silences "lacks return statement" errors

---

## Architecture

### Monorepo layout
```
packages/
  core/
    runner/        — agentic loop, hook dispatch, plugin loader (@matatbread/matbot-core)
    plugin-api/    — MatbotPlugin, MatbotServices, all shared types (@matatbread/matbot-plugin-api)
    config/        — YAML loading, .env parsing
    security/      — VaultImpl, principal (origin of operations); resolves ${NAME} placeholders
    knowledge/     — LookupKnowledgeIndex (default in-memory KnowledgeIndex implementation)
    storage/
      _base/       — filter/sort engine shared by all Store implementations
      filesystem/  — FilesystemStore<T> (Node, CAS-safe)
    providers/
      _base/       — SSE parser, shared HTTP helpers
    tool-plugin/   — built-in plugin and provider management tools (@matatbread/matbot-tool-plugin)

  plugins/
    rumsfeld/      — contextual_search tool; knowledge fault handler (@matatbread/matbot-rumsfeld-node)
    persist-ki-bge/ — persistent KnowledgeIndex with BGE reranker (@matatbread/matbot-persist-ki-bge-node)
    skills/        — cross-runtime skill CRUD (skill_action) + classifier hooks (@matatbread/matbot-skills)
    skills-node/   — node specialization: embeds skills, adds local .md filesystem import/watch (@matatbread/matbot-skills-node)
    edit-session/  — session_edit tool (cut/fork/split/compact via action) (@matatbread/matbot-edit-session)
    files/         — file codec and producer registry
    browser/       — OPFS store, WebCrypto vault (browser-only)
    frontend/
      web/         — HTTP + SSE web UI with session management
      telegram/    — Telegram bot frontend (@matatbread/matbot-frontend-telegram)
    providers/
      anthropic/   — Anthropic Messages API adapter (also handles DeepSeek Anthropic-compat)
      openai-compat/ — OpenAI-compatible chat completions adapter
    tools/
      bash/        — exec tool (@matatbread/matbot-tool-bash)
      docker-bash/ — sandboxed exec inside Docker
      http/        — HTTP request tool
      schedule/    — timer/delay tool
      workspace/   — workspace file tools

apps/
  cli/             — interactive REPL + single-turn mode
```

### Package naming
- `@matatbread/matbot-foo` for packages with a single implementation
- `@matatbread/matbot-foo-types` for interface-only packages (no implementation; augments `MatbotServices`)
- `@matatbread/matbot-foo-node` / `@matatbread/matbot-foo-browser` for platform-specific implementations

### Dependency direction
`apps` → `packages/plugins/*-node` → `packages/plugins/*-types` → `packages/core/plugin-api`
`packages/core/runner` → `packages/core/plugin-api`
Nothing in `packages/` may depend on `apps/`.

---

## Provider model

Providers are named LLM configurations in `matbot.yaml`. Each name is **fully self-contained**:

```yaml
providers:
  claude-sonnet-4-6:
    module: ./packages/plugins/providers/anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-4-6
    credentials:
      apiKey: ${ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 4096
```

- Prefer duplication over references — five similar provider blocks is fine
- `${NAME}` placeholders are resolved at runtime by the `Vault`; the YAML loader leaves them intact.
  There is no env/secret distinction — a name resolves against one flat namespace (`.env` is just
  the default node backend). `createSecret` returns the canonical key name to reference (it may
  differ from the requested name — see the `Vault` interface); `writeSecret` stores verbatim
- Credentials never appear in source code
- `module` is the npm package name or relative path of the provider plugin; `endpoint` overrides
  the base URL
- The built-in `provider` tool can add and remove profiles live — no restart needed

---

## Data layout

When using the built-in filesystem storage. Other storage providers will differ (for example
the optional SQLite plugin stores all data in a local SQLite DB)

All runtime state lives under `.data/` **next to `matbot.yaml`**, never in the source tree:

```
.data/
  sessions/    — Store<Session>
  settings/    — Store<SettingsDoc> (plugin key-value settings)
  skills/      — Store<SkillDoc>
  schedules/   — Store<Schedule> (background plugin recurring jobs)
  knowledge/   — Store<KnowledgeEntry> (persist-ki-bge plugin)
  bash-cwd/    — default working directory for bash tool execution (created lazily)
  files/       — FileStore blobs (MIME-typed, served by frontend); the 'workspace' namespace
               within files/ holds files written by workspace_action (write)
```

Plugins may create additional subdirectories (e.g. `files/`, `settings/`) as needed.
`.data/` is gitignored. Source and data are always separate.

---

## Service registry

`MatbotServices` is the runtime environment passed to every plugin's `setup()`. Its core
members (hooks, tools, complete, settings, vault, sessions) are always present. Optional
services — custom cognitive subsystems, domain-specific backends, etc. — are advertised and
consumed through `register` and `get`, both typed against `keyof MatbotServices`:

```ts
// Advertising (in the providing plugin's setup()):
await services.register('myService', new MyServiceImpl(store));

// Consuming (in any plugin's setup()):
const svc = services.get('myService'); // MyService | undefined
```

Type safety comes from augmenting `MatbotServices` in `@matatbread/matbot-plugin-api`:

```ts
// In the providing package (or alongside it):
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    myService?: MyService;
  }
}
```

Any plugin that imports this declaration gets fully-typed `register`/`get` calls. Core
never references plugin services — they are negotiated at runtime between plugins.

Well-known keys have dedicated behaviour inside `register`:
- `'storageBackend'` — replaces the active storage backend and re-wires all Store proxies
- `'knowledge'` — replaces the active KnowledgeIndex, draining entries from the old one

To introduce a new cognitive subsystem (e.g. `Imagination`):
1. Declare `imagination?: Imagination` on `MatbotServices` (augment in your package)
2. Call `await services.register('imagination', new ImaginationImpl(...))` in `setup()`
3. Core is unchanged; other plugins discover the service via `services.get('imagination')`

**Name collision**: the property name becomes the contract identifier. Choose a name
that is unambiguous within the ecosystem — short but domain-specific beats globally unique.

### Registry discovery vs. direct dependency

The registry is for **negotiation between independent parties**: the consumer neither knows nor
cares who provides a capability, whether anyone does, or which implementation answers. That
looseness is the whole point — it buys runtime swappability and graceful absence. Reach for
`services.get('x')` (and the `x?:` optional on `MatbotServices`) only when that's genuinely true.
Genuine optional discovery has **no fallback**; it degrades (`if (!svc) return;`).

When one plugin is a **specialization** of another — "B *is* A, but broader" — that is an `extends`
relationship, not an unknown-collaborator one. The dependency is named, owned, present by
construction, and singular, so express it as a plain `import` + construct and a hard `package.json`
dependency. Routing it through the registry there is ceremony around a fact known at author time,
and it has real costs: a second resident plugin, lifecycle split across two `teardown`s (cleanup
becomes load-order dependent), and capabilities registered only to be immediately overridden.

The tell is the fallback. The moment you write `get(x) ?? loadPlugin(x)`, you've admitted the
dependency isn't optional — you're willing to *force* it into existence. That `??` is the seam
between the two models; reaching for it means you've picked the loose tool for a hard relationship.

The two halves compose and aren't in tension: a specialization may still **advertise** its own
capability on the registry (offering loosely to whoever's out there) while **depending** on its
base directly. Offer loosely; depend tightly. *(See `packages/plugins/mcp` embedding
`packages/plugins/mcp-http`'s `RemoteMcpManager` directly, while mcp-http still registers
`mcpRemote` for standalone use.)*

---

## Knowledge subsystem

`KnowledgeIndex` is a **core** service (always present on `MatbotServices`). It stores named knowledge entries and supports term-based and semantic search.

The default implementation (`LookupKnowledgeIndex` in `packages/core/knowledge/`) is
in-memory and scores by term frequency. `packages/plugins/persist-ki-bge/` replaces it with
a `Store<KnowledgeEntry>`-backed index that survives restarts and optionally calls a
Cloudflare BGE reranker for semantic scoring.

`packages/plugins/rumsfeld/` registers a `contextual_search` tool that queries the active
`KnowledgeIndex` when the model encounters an unknown term. This is the primary consumption
path: the model calls `contextual_search`, gets back the best-matching entry, and continues.

`services.register('knowledge', impl)` swaps the active index at runtime — all subsequent
`contextual_search` calls use the new backend immediately.

---

## Storage

`Store<T extends { id: string; version: string }>` is the universal interface.
All writes use compare-and-swap (`store.cas(id, expectedVersion, next)`) for thread safety.
Never write to a store without a version check when concurrent updates are possible.

---

## Security principal

A `Principal` (`{ id, type }`) is the identity that originated the current operation. It is carried
**ambiently**, not threaded through signatures: there is one mechanism, the `PrincipalCarrier`,
installed once at boot and read anywhere via free functions exported from `@matatbread/matbot-core`:

- `currentPrincipal()` — the identity in force; throws if read outside any established scope.
- `tryCurrentPrincipal()` — same, but `undefined` instead of throwing (fail-open backends).
- `runAs(principal, fn)` — establish `principal` for the async extent of `fn` (nests cleanly).
- `enterPrincipal(principal)` — imperative establishment at a process/request *entry* (throws on re-entry).

**Why ambient, not a parameter.** The requirement is that the principal survive top-to-bottom,
*including across tool-use boundaries*, into `Store`/`FileStore`/`Vault`/`KnowledgeIndex` and
`complete()`. Threading it would make the security model opt-in at every call site (a tool that
forgets to pass it is indistinguishable from a system call). Ambient propagation is un-forgettable:
established once at the entry, every downstream call sees it with zero plumbing and **no interface
churn** — backends gain only the *ability* to call `currentPrincipal()`; the stock impls ignore it.
Passing is the mechanism's job; reject/ignore/branch is the service's.

**Platform split** (mirrors `Vault`):
- node — `createAlsPrincipalCarrier()` (`apps/cli`, `AsyncLocalStorage`-backed). The many concurrent
  per-session `pump` loops and per-request frontend handlers each get an isolated scope — the
  multi-user case. Lives in the node app so `packages/core` stays node-free.
- browser / single-principal realms / tests — `createConstantPrincipalCarrier(principal)` (neutral,
  in plugin-api). There is only ever one identity, so `run` is a passthrough and no isolation is needed.

**Establishment points (entry-only).** Frontends establish at their entry — the CLI `enterPrincipal`s
the system principal at boot; the web server `runAs` per HTTP request; telegram `runAs` per message.
The `SessionRunner`'s `pump` separately wraps each turn in `runAs(submitter)` because it runs detached
(`void pump`) from the request that enqueued it. In-process delegation is a nested `runAs`; cross-process
delegation (a spawned worker) re-establishes at its own entry via `enterPrincipal`.

`Session` persists `ownerPrincipalId`/`actorPrincipalId` as ownership *data* (set explicitly via
`createSession`) — that is record-keeping, not the ambient mechanism.

---

## Hooks

```
before:submit   → can mutate session or abort
after:submit    → observe final session
before:response → runs between tool results and next LLM call
after:response  → (reserved)
before:tool     → capability check, rate limiting
after:tool      → audit logging
```

Hooks receive and return `HookContext`; they may replace `ctx.session` to inject context.
They may set `ctx.abort` to cancel the turn.

---

## Tool design — multi-action tools (preferred, not enforced)

When a plugin exposes several closely-related operations (a noun with a handful of verbs —
`mcp` add/list/remove, sessions list/get/rename, schedule list/suspend/resume/cancel), the
**preferred** style is to collapse them into a single tool that takes an `action` discriminator
rather than shipping one `noun_verb` tool per verb. This is a convention, **not** a rule the
runtime enforces — nothing breaks if you ship separate tools, and some tools should stay
separate (see below).

The shape that has worked well:

- **One description that teaches the domain once.** The wordy shared context (what the thing is,
  the gotchas) lives in a single place; the verbs are usually self-evident given that context.
- **Per-action contract as a TypeScript discriminated union in the description.** LLMs read a TS
  union (`{ action: 'add'; name: string; … } | { action: 'list' } | …`) far more reliably than a
  verbose JSON-Schema `oneOf`, which providers honour inconsistently.
- **Keep `inputSchema` loose** — `required: ['action']` plus the union of every action's optional
  fields. **The executor enforces** per-action requirements and emits a loud `error` event on a
  missing field or unknown action. (`switch (action)` with a `default` that errors.)

**When to collapse:** the operations share a parameter shape, *or* they share a domain worth
teaching once. Parameter divergence between actions is fine — that is exactly what the
discriminated union absorbs.

**When to keep separate (the other valid style):** genuinely standalone, single-purpose tools
with nothing to share (`http`, `bash`, `ask_user`), or operations that belong to qualitatively
different concerns even within one plugin — e.g. the telegram frontend keeps `telegram_send`
(messaging), `telegram_provider` (config), and `telegram_open_door` (admission/permissions)
separate rather than forcing a hollow `telegram_action` over three unrelated jobs.

**Cross-references between tools may only point *down* the dependency graph** — a tool may name
another tool that is guaranteed present (same plugin, or a hard dependency), never an optional
dependent that dangles when its plugin is absent.

---

## Thinking blocks (Anthropic extended thinking)

When `parameters.thinking` is set, the Anthropic adapter captures both the thinking text and
its cryptographic `signature`. Complete thinking blocks are stored in session messages as
`{ type: 'thinking', thinking: string, signature: string }` and round-tripped back to the API
verbatim. Never strip thinking blocks from message history.

---

## Markers

Markers are opaque, durable annotations carried in the message stream — links, status, and
cross-references that mean something to a frontend or another plugin but are transparent to the
LLM. A marker is stored as a `MessageContent` block,
`{ type: 'marker', creator: string, data: unknown }` — `creator` is the emitting plugin's
reference, `data` anything serialisable. A standalone marker is its own message with the dedicated
`marker` role (`MessageRole`), so every provider adapter skips it rather than letting it
masquerade as tool-protocol I/O.

Invariants: markers are **elided from LLM submission**, **persisted unchanged**, and **preserved
by session compaction** — removing one can break things (e.g. a pointer back to an ancestor
session). For per-creator type safety, augment the `MarkerData` registry and read/write through
`Marker<'your-creator'>` (the same augmentation pattern as `MatbotServices`); the base
`MessageContent` member stays loose so exhaustive switches are unaffected. Any code with session
access may emit a marker — interpreting and rendering it is the creator's and the frontend's
concern, never the core's.

---

## Plugin hot-reload

A plugin can be reloaded from disk without restarting the process (the `plugin reload` tool;
`loadPlugins(..., bustCache = true)`). The requirement is **freshness all the way down**: if a
plugin's code — or the code of any module it imports — changed since startup, the reload must
re-evaluate it. The mechanism is split so the platform-neutral core stays node-free:

- **Core marks intent.** `toFreshUrl` in `packages/core/runner/src/loader.ts` stamps the plugin
  *entry* URL with a namespaced query param (`?mbfresh=<gen>`, `FRESH_PARAM`). On its own this
  re-evaluates only the entry — a barrel re-export would leave all the real code behind it cached.
- **A node-only resolve hook propagates it.** `apps/cli/ts-hooks.js` (registered via
  `--import ./register.js`) reads the stamp off `context.parentURL` and re-stamps the entry's
  first-party imports, cascading the generation through the whole subtree. The marker is just an
  inert query string anywhere no such hook is installed — browser builds reload the whole realm
  (`location.reload()`) instead, and node without the hook degrades to entry-only busting.
- **The boundary is "only what the plugin API loaded".** The stamp originates solely at the plugin
  entry and flows through *its* graph; it stops at host-shared singletons. `register.js` resolves
  the host-shared package roots (`@matatbread/matbot-core`, `@matatbread/matbot-plugin-api`) and
  passes them to the hook as an exclusion set. This is mandatory, not cosmetic: those packages
  export runtime values used with identity semantics (e.g. `MissingSecretError`, matched with
  `instanceof`). Re-stamp one and the reloaded plugin gets a *second copy* of the module, and
  cross-boundary `instanceof` / shared-state checks silently break.

### Caveats

- **Memory: every reload leaks its subtree.** Node's ESM module registry never evicts, and each
  distinct `?mbfresh=<gen>` URL is a permanent new entry. A reloaded plugin's entire re-stamped
  subtree stays resident for the life of the process. This is acceptable *because reloads are
  rare* (startup-and-done for ~99% of runs); it is **not** a mechanism to call on a timer, per
  request, or per turn. There is no `require.cache`-style eviction for ESM — true reclamation
  needs a dropped realm (worker/child process or `vm` modules), which we deliberately did not build.
- **First-party only by default.** The exclusion protects `core` + `plugin-api`; everything else
  the plugin reaches, *including its private `node_modules` deps*, is re-evaluated on reload. That
  is correct for "code changed all the way down", but a third-party lib holding a module-level
  singleton not routed through `services` would be duplicated. matbot's "all shared state goes
  through `services`, not shared module imports" rule is what keeps this safe; if you ever hit a
  lib that breaks it, add its package root to `hostSharedDirs()` in `register.js`.
- **The stamp must reach children as static imports.** Propagation is via `context.parentURL`, so
  it follows the static import graph. A module pulled in by a bare dynamic `import(userString)`
  with no stamped parent context is busted only if it resolves through a stamped ancestor.
- **Keep `FRESH_PARAM` and the hook's marker name in sync.** Core writes it; the node hook reads
  it. They are intentionally decoupled (core must not import node code), so the contract is the
  literal param name — documented at both ends.
- **Diagnostics.** `toFreshUrl` warns when `import.meta.resolve` throws and it falls back to the
  cached module (no busting at all), and `loadPlugins` notes when busting runs without the hook
  (entry-only). A reload that "doesn't pick up changes" should first be checked against these logs.

---

## Code style

- No provider SDKs (already said — worth repeating)
- No comments explaining *what* code does; only comments for non-obvious *why*
- No trailing summaries, no docblocks
- No premature abstractions — three similar functions beat one leaky abstraction
- No error handling for impossible cases; trust TypeScript's discriminated unions
- Validate only at system boundaries (user input, HTTP responses, file reads)
- `types: ["node"]` must be explicit in any `tsconfig.json` that uses Node APIs — the base config
  does not include it because shared packages must be platform-neutral
