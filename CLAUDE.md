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
    security/      — VaultImpl, principal/grants; resolves ${env:} and ${secret:} placeholders
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
    skills/        — skill injection via hook-based classifier (@matatbread/matbot-skills-node)
    edit-session/  — edit_session_cut/fork/compact tools (@matatbread/matbot-edit-session)
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
      apiKey: ${env:ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 4096
```

- Prefer duplication over references — five similar provider blocks is fine
- Both `${env:VAR}` and `${secret:name}` are resolved at runtime by `VaultImpl`; the YAML loader
  leaves placeholders intact
- Credentials never appear in source code
- `module` is the npm package name or relative path of the provider plugin; `endpoint` overrides
  the base URL
- The built-in `provider` tool can add and remove profiles live — no restart needed

---

## Data layout

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
               within files/ holds files written by workspace_write
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

## Thinking blocks (Anthropic extended thinking)

When `parameters.thinking` is set, the Anthropic adapter captures both the thinking text and
its cryptographic `signature`. Complete thinking blocks are stored in session messages as
`{ type: 'thinking', thinking: string, signature: string }` and round-tripped back to the API
verbatim. Never strip thinking blocks from message history.

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
