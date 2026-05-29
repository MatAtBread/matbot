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
    plugin-api/    — MatbotPlugin, MatbotServices, ServiceMap, all shared types (@matatbread/matbot-plugin-api)
    config/        — YAML loading, .env parsing, placeholder resolution
    security/      — VaultImpl, principal/grants
    storage/
      _base/       — filter/sort engine shared by all Store implementations
      filesystem/  — FilesystemStore<T> (Node, CAS-safe)
    providers/
      _base/       — SSE parser, shared HTTP helpers
    tool-plugin/   — built-in plugin management tool (@matatbread/matbot-tool-plugin)

  plugins/
    memory-types/  — MemoryManager interface + ServiceMap augmentation (@matatbread/matbot-memory-types)
    memory/        — MemoryManagerImpl, JobQueueImpl, MemoryExtractorWorker (@matatbread/matbot-memory-node)
    skills/        — skill injection via hook-based classifier (@matatbread/matbot-skills-node)
    files/         — file codec and producer registry
    browser/       — OPFS store, WebCrypto vault (browser-only)
    frontend/
      web/         — HTTP + SSE web UI with session management
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
- `@matatbread/matbot-foo-types` for interface-only packages (no implementation, used as ServiceMap keys)
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
    type: anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-4-6
    credentials:
      apiKey: ${env:ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 4096
```

- Prefer duplication over references — five similar provider blocks is fine
- `${env:VAR}` is resolved at config-load time; `${secret:name}` is resolved at runtime by `VaultImpl`
- Credentials never appear in source code
- `type` selects the adapter (`anthropic` or `openai-compat`); `endpoint` overrides the base URL

---

## Data layout

All runtime state lives under `.data/` **next to `matbot.yaml`**, never in the source tree:

```
.data/
  sessions/    — one JSON file per Session, named by UUID
  workspace/   — default cwd for exec tool; LLM file output goes here
```

Plugins may create additional subdirectories (e.g. `files/`, `settings/`) as needed.
`.data/` is gitignored. Source and data are always separate.

---

## Service registry

`MatbotServices` is the runtime environment passed to every plugin's `setup()`. Its core
members (hooks, tools, complete, settings, vault, sessions) are always present. Additional
services — memory, file stores, custom cognitive subsystems — are advertised and consumed
through a typed open registry:

```ts
// Consuming a service (in any plugin's setup()):
const memory = services.get('@matatbread/matbot-memory-types');

// Advertising a service (in a plugin's setup()):
services.register('@matatbread/matbot-memory-types', new MemoryManagerImpl(store));
```

The key is the **npm package name of the types package** that defines the interface. This
guarantees global uniqueness (npm enforces it) and makes the contract self-documenting.
TypeScript type safety comes from module augmentation of the `ServiceMap` interface in
`@matatbread/matbot-plugin-api`:

```ts
// In @matatbread/matbot-memory-types:
declare module '@matatbread/matbot-plugin-api' {
  interface ServiceMap {
    '@matatbread/matbot-memory-types': MemoryManager;
  }
}
```

Any plugin that imports the types package gets a fully-typed `services.get(...)` call at
compile time. Core never references `MemoryManager` or any other optional service — they
are negotiated at runtime between plugins.

To introduce a new cognitive subsystem (e.g. `Imagination`):
1. Create `@matatbread/matbot-imagination-types` — interface only, augments `ServiceMap`
2. Create one or more implementation packages that depend on the types package
3. Core is unchanged; other plugins discover the service via `services.get(...)`

---

## Memory subsystem

Memory types (`MemoryManager`, `MemoryEntry`, `RecallQuery`, `ContextBlock`) live in
`@matatbread/matbot-memory-types`. The implementation (`MemoryManagerImpl`, `JobQueueImpl`,
`MemoryExtractorWorker`) lives in `@matatbread/matbot-memory-node`.

The LLM does **not** have direct memory tools. Memory is a subsystem concern:

- **Live capture** (hooks): `before:submit` / `after:submit` hooks extract high-confidence facts
  and store them before the next turn
- **Passive capture** (job queue): `MemoryExtractorWorker` processes sessions out-of-band,
  calling a classifier LLM to assign confidence, tags, and embeddings
- **Injection**: `MemoryManager.buildContext(session, signal)` returns `ContextBlock[]` (role:
  `'system'`) prepended to the conversation at session start — not on every turn, to preserve
  the provider's prompt cache
- Memories store **references** back to session messages (`sessionId` + `messageId`), not copies
  of text

A plugin that provides memory calls `services.register('@matatbread/matbot-memory-types', impl)`
in its `setup()`. A plugin that consumes memory calls `services.get('@matatbread/matbot-memory-types')`.

The storage backend is swappable: `MemoryManagerImpl` depends only on `Store<MemoryEntry>`.
Any storage plugin (filesystem, SQLite, Elasticsearch) that satisfies that interface can back
the memory subsystem without touching the cognitive layer.

---

## Storage

`Store<T extends { id: string; version: string }>` is the universal interface.
All writes use compare-and-swap (`store.cas(id, expectedVersion, next)`) for thread safety.
Never write to a store without a version check when concurrent updates are possible.

---

## Hooks

```
before:submit   → can mutate session or abort
after:submit    → observe final session; trigger memory extraction
before:response → runs between tool results and next LLM call
after:response  → (reserved)
before:tool     → capability check, rate limiting
after:tool      → audit logging
```

Hooks receive and return `HookContext`; they may replace `ctx.session` to inject context
(e.g. memory blocks). They may set `ctx.abort` to cancel the turn.

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
