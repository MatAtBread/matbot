# matbot — Design Principles

This file is the authoritative guide for anyone (human or LLM) working on this codebase.
Read it before making any structural decisions.

---

## What matbot is

A TypeScript AI harness — a thin, composable runtime that connects language models to tools,
memory, and frontends. It is not a product; it is infrastructure.

---

## Hard constraints

### No provider SDKs
All LLM communication is plain HTTP using the web-platform `fetch` API.
Never import `@anthropic-ai/sdk`, `openai`, or any other provider SDK.
Use the HTTP endpoints directly; stream via SSE parsed with `parseSSE` from `@matbot/providers-base`.

### No Node-specific primitives in shared packages
Packages under `packages/` (except those explicitly suffixed `/node`) must run in both Node and
the browser. Use web-platform APIs: `fetch`, `crypto.randomUUID()`, `AbortController`,
`AbortSignal`, `TextDecoder`, `ReadableStream`, `SubtleCrypto`. Never use `require`,
`Buffer`, `EventEmitter`, `fs`, `path`, `child_process`, or `os` in shared packages.
Node-only code lives in `packages/*/node/` or `apps/`.

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
  core/          — types, runner, hooks, session helpers (no I/O)
  config/        — YAML loading, .env parsing, placeholder resolution
  security/      — VaultImpl (secret resolution), principal/grants
  providers/
    _base/       — SSE parser, shared HTTP helpers
    anthropic/   — Anthropic HTTP adapter (also used for DeepSeek Anthropic-compat)
    openai-compat/ — OpenAI-compatible HTTP adapter
  storage/
    _base/       — filter/sort engine shared by all store implementations
    filesystem/  — FilesystemStore<T> (Node, CAS-safe)
  memory/
    _base/       — MemoryManagerImpl, JobQueueImpl
    node/        — MemoryExtractorWorker, watchSkillDir
  tools/
    _base/       — tool registry helpers
    plugin/      — plugin management tool (@matbot/tool-plugin)
    exec/        — bash tool (@matbot/tool-bash)
    http/        — http tool (@matbot/tool-http)
    schedule/    — schedule tool (@matbot/tool-schedule)
  browser/       — OPFS store, WebCrypto vault (browser-only)

apps/
  cli/           — interactive REPL + single-turn mode
```

### Package naming
- `@matbot/foo` for packages with a single implementation
- `@matbot/foo-base` for the shared interface/logic layer
- `@matbot/foo-node` / `@matbot/foo-browser` for platform-specific implementations

### Dependency direction
`apps` → `packages/*/node` or `packages/*/browser` → `packages/*/_base` → `packages/core`  
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
  jobs/        — job queue persistence (when used)
  memory/      — MemoryEntry store (when used)
```

`.data/` is gitignored. Source and data are always separate.

---

## Memory subsystem

The LLM does **not** have direct memory tools. Memory is a subsystem concern:

- **Live capture** (hooks): `before:submit` / `after:submit` hooks extract high-confidence facts
  synchronously and store them before the next turn
- **Passive capture** (job queue): `MemoryExtractorWorker` processes sessions out-of-band,
  calling a classifier LLM to assign confidence, tags, and embeddings
- **Injection**: `MemoryManager.buildContext(session, signal)` returns `ContextBlock[]` (role:
  `'system'`) prepended to the conversation at session start — not on every turn, to preserve
  the provider's prompt cache
- Memories store **references** back to session messages (`sessionId` + `messageId`), not copies
  of text

---

## Storage

`Store<T extends { id: string; version: string }>` is the universal interface.
All writes use compare-and-swap (`store.cas(id, expectedVersion, next)`) for thread safety.
Never write to a store without a version check when concurrent updates are possible.

---

## Hooks

```
before:submit  → can mutate session or abort
after:submit   → observe final session; trigger memory extraction
before:response → runs between tool results and next LLM call
after:response  → (reserved)
before:tool    → capability check, rate limiting
after:tool     → audit logging
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
