# matbot — Design Principles

Authoritative guide for anyone (human or LLM) working on this codebase.

---

## What matbot is

A TypeScript AI harness — a thin, composable runtime connecting language models to tools and frontends. Infrastructure, not a product.

---

## Hard constraints

**No provider SDKs.** All LLM communication uses `fetch` with SSE parsed via `parseSSE` from `@matatbread/matbot-providers-base`. Never import `@anthropic-ai/sdk`, `openai`, or equivalents.

**No Node primitives in shared packages.** Packages under `packages/` (except those suffixed `-node`) must run in Node and browser. Use `fetch`, `crypto.randomUUID()`, `AbortController`, `ReadableStream`, `TextDecoder`, `SubtleCrypto`. Never use `require`, `Buffer`, `EventEmitter`, `fs`, `path`, `child_process`, `os`, or `process.env`.

Secrets and configuration go through the `Vault` (`${NAME}` placeholders) or plugin `Settings` — both have swappable backends. Reaching for `process.env` directly is non-portable.

**AsyncIterators, not callbacks.** Streaming flows through `AsyncIterable<T>`. Never `EventEmitter` or raw callbacks for inter-layer communication.

**Strict TypeScript.** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Optional fields require conditional spreads; array/map indexing returns `T | undefined`; prefer `throw` over `process.exit(1)`; use `switch` exhaustiveness on discriminated unions.

---

## Architecture

### Monorepo layout
```
packages/
  core/
    runner/        — agentic loop, hook dispatch, plugin loader
    plugin-api/    — MatbotPlugin, MatbotServices, shared types
    config/        — YAML + .env loading
    security/      — VaultImpl, Principal origin
    knowledge/     — LookupKnowledgeIndex (default in-memory)
    storage/
      _base/       — filter/sort engine
      filesystem/  — FilesystemStore<T> (Node, CAS-safe)
    providers/
      _base/       — SSE parser, HTTP helpers
    tool-plugin/   — built-in provider management tools
  plugins/
    rumsfeld/      — contextual_search tool; knowledge fault handler
    persist-ki-bge/— persistent KnowledgeIndex + BGE reranker
    triggers/      — data-driven hooks (condition → tool invocation)
    skills/        — skill CRUD + catalogue (cross-runtime)
    skills-node/   — node specialization: .md import/watch
    edit-session/  — session_edit tool (cut/fork/split/compact)
    files/         — file codec and producer registry
    hook-logger/   — diagnostic: logs every hook channel
    browser/       — OPFS store, WebCrypto vault
    frontend/
      web/         — HTTP+SSE server (node) + in-process (browser)
      dom/         — minimal in-process browser chat
      telegram/    — Telegram bot frontend
    providers/
      anthropic/   — Anthropic Messages API adapter
      openai-compat/— OpenAI-compatible adapter
    tools/
      bash/, docker-bash/, http/, schedule/, workspace/
apps/
  cli/             — interactive REPL + single-turn
  web-bundle/      — browser-only matbot.html
```

**Dependency direction:** `apps` → `packages/plugins/*-node` → `packages/plugins/*` → `packages/core/plugin-api`. `packages/core/runner` → `packages/core/plugin-api`. Nothing in `packages/` may depend on `apps/`.

### Package naming
- `@matatbread/matbot-foo` — single implementation
- `@matatbread/matbot-foo-types` — interface-only (augments `MatbotServices`)
- `@matatbread/matbot-foo-node` / `-browser` — platform-specific

---

## Provider model

Named LLM configurations in `matbot.yaml`, fully self-contained:

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

- Prefer duplication over references **for provider config blocks specifically** — five similar `matbot.yaml` blocks is fine. This is a config-authoring exception, not a general code-style rule — see Code style for shared *code*.
- `${NAME}` resolved by `Vault` at runtime (flat namespace; `.env` is default node backend)
- Credentials never in source code
- Built-in `provider` tool adds/removes profiles live

---

## Data layout

All runtime state under `.data/` **next to `matbot.yaml`**, never in source:

```
.data/
  sessions/, settings/, skills/, triggers/, schedules/
  knowledge/, bash-cwd/, files/
```

`.data/` is gitignored. Plugins may add subdirectories. Other storage providers (e.g. SQLite) differ.

**`.plugins/`** — fetched remote-plugin cache, **separate** from `.data/`. `.data/` is LLM read-write runtime state; `.plugins/` is matbot-writes / LLM-reads-only (mounted read-only into docker-bash). Never relocate it. Gitignored.

---

## Service registry

`MatbotServices` is the runtime environment passed to every plugin's `setup()`. Core members (hooks, tools, complete, settings, vault, sessions) are always present. Optional services advertised with `register` and consumed as **members** — one access surface:

```ts
// Providing:
await services.register('McpRemoteService', new RemoteMcpManager(store));

// Consuming:
services.McpRemoteService?.add(...);
```

Type safety via augmentation:
```ts
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    McpRemoteService?: McpRemoteService;
  }
}
```

**Key is the interface name — no translation.** The registry holds interfaces; the string is the erasure-time stand-in for type identity. Name the key exactly after the interface it carries.

**Two implementations of one interface?** Alias, don't invent role names:
```ts
type SessionStore = Store<Session>;
type ScratchStore = Store<Session>;
```

**Swappable core members** (`StorageBackend`, `KnowledgeIndex`, `Vault`) use `register` to swap live impls behind capture-safe forwarding proxies. A captured reference keeps resolving to the current impl.

### Discovery vs. direct dependency

Registry is for **negotiation between independent parties** — consumer neither knows nor cares who provides a capability. Use `services.x` (with `?:` optional) only when absence is genuinely acceptable; degrade gracefully (`if (!services.x) return;`), no fallback.

When one plugin **specializes** another ("B *is* A, but broader"), that's an `extends` relationship — express it with a plain `import` + construct and hard `package.json` dependency. The moment you write `services.x ?? loadPlugin(x)`, the dependency isn't optional. **Offer loosely; depend tightly.**

---

## Knowledge subsystem

`KnowledgeIndex` is a **core** service. Default: `LookupKnowledgeIndex` (in-memory, term frequency). `persist-ki-bge` replaces it with `Store<KnowledgeEntry>`-backed persistence + optional BGE reranker. `rumsfeld` registers `contextual_search` tool — the primary consumption path. `register('KnowledgeIndex', impl)` swaps at runtime.

---

## Storage

`Store<T extends { id: string; version: string }>` — universal interface. All writes use compare-and-swap (`store.cas(id, expectedVersion, next)`). Never write without version check when concurrent updates are possible.

---

## Security principal

A `Principal` (`{ id, type }`) is the operation origin, carried **ambiently** (not threaded through signatures):

- `currentPrincipal()` — identity in force; throws outside any scope
- `tryCurrentPrincipal()` — `undefined` instead of throwing
- `runAs(principal, fn)` — establish for async extent
- `enterPrincipal(principal)` — imperative entry (throws on re-entry)

**Why ambient.** The principal must survive tool-use boundaries into `Store`/`FileStore`/`Vault`/`KnowledgeIndex`/`complete()`. Threading makes security opt-in; ambient propagation is un-forgettable.

**Platform split:** node uses `AsyncLocalStorage`-backed carrier (in `apps/cli`); browser/single-principal uses constant carrier (in plugin-api).

**Establishment points:** entry-only — CLI `enterPrincipal`s boot principal; web server `runAs` per request; telegram `runAs` per message; `SessionRunner.pump` wraps each turn in `runAs(submitter)`.

**Boot principal resolution** (platform-specific entry concern):
- Node: `--principal` flag → `MATBOT_PRINCIPAL` env → `matbot.yaml` `principal:` → `systemPrincipal()`
- Browser: `BrowserConfig.principal` or anonymous `web-user`
- Web: `WebPrincipalResolver` from registry, resolved at request receipt
- Cross-process: serialized via env, re-established at child entry

---

## Hooks

Sorted by **job**, not lifecycle position. `Hook` is a discriminated union keyed by `on`. Register: `services.hooks.register({ on, handler })`. Each channel's `ctx` carries `removeHook()` for one-shot hooks.

A throwing handler is isolated (caught, logged, skipped) — never propagated. An intentional stop is a *return value* (`abort`/`rejectTool`), not a throw. Throwing hooks surface as `matbot-hooks` markers.

| `on` | Cadence | Session | Effects |
|---|---|---|---|
| `screen`     | once per turn, before 1st provider call | read-write | replace `session`, add `ephemeral` context (tail of outgoing messages, never persisted), append durable `markers`, and/or `abort` |
| `contribute` | before *every* provider call | read-only | return transformed `outgoing` copy (ephemeral) |
| `toolcall`   | before each tool exec | read-only | `rejectTool` and/or `abort` |
| `toolresult` | after each tool exec | read-only | replace `result` (redaction) or observe |
| `followup`   | once, post-commit | read + durable-marker | `resubmit` robo turn, `retractAndRerun` (pop committed turn, re-run with context), append durable `markers` |

`screen` and `followup` are the durable-mutate points (once per turn). `contribute` is the in-harness cousin of a wrapping provider — mind prompt caching: inject at the tail or as stable prefix.

### Authorship vs. role

`role` is LLM-protocol identity; **authorship** (`origin?: 'robo'` on `MessageContent`) records who produced it for presentation — orthogonal. Frontends present by author; the LLM operates by role. A "robo message" has all blocks `origin: 'robo'`.

---

## Triggers (data-driven hooks)

Stored documents turning condition-based wiring into **data**:

```ts
interface Trigger {
  id; version;
  conditions: { kind: 'augment' | 'retract' | 'followup'; rule: string }[];
  invoke: { tool: string; params?: unknown };
  enabled?: boolean; createdAt; updatedAt;
}
```

**Triggers name a *tool*, not a skill.** "Apply a skill" is `invoke: skill_action({ action: 'use', … })` — a specialization, not a special case.

**Conditions are OR; `invoke` is the consequence.** Each condition is an LLM-judged rubric. `kind` determines surface judged, hook used, and delivery:
- **`augment`** — judge user message in `screen` hook; inject ephemerally
- **`retract`** — judge assistant response in `followup` hook; pop and re-run
- **`followup`** — judge assistant response in `followup` hook; resubmit as robo turn

**Observational dispatch:** tool's output is the signal. A `result` → inject; no result → silent side-effect. The dispatcher is a dumb transport — tools frame themselves.

**Fails soft.** Absent tool → nothing happens. Conditions evaluated by a classifier provider (Settings-resolved, falls back to turn's provider). Zero config required.

**Orthogonal to skills.** Skills own content; triggers own conditions and firing. A skill is fired only by a trigger naming it.

---

## Tool design — multi-action tools

**Preferred:** collapse related operations into one tool with an `action` discriminator. One description teaches the domain once; per-action contract as a TypeScript discriminated union in the description; `inputSchema` loose (`required: ['action']`), executor enforces. Use when operations share a domain or parameter shape.

**Keep separate:** genuinely standalone tools (`http`, `bash`, `ask_user`) or qualitatively different concerns (telegram's `send`/`provider`/`open_door`).

**Cross-references** may only point down the dependency graph — never to optional dependents.

---

## Thinking blocks (Anthropic)

When `parameters.thinking` is set, complete `{ type: 'thinking', thinking, signature }` blocks are stored and round-tripped verbatim. Never strip them.

---

## Markers

Opaque, durable annotations in the message stream — `{ type: 'marker', creator: string, data: unknown }`. Stored as marker-role messages, **elided from LLM submission**, **persisted unchanged**, **preserved by compaction**. A tool emits one via `marker` `ToolEvent`; the triggers dispatcher collects and persists them for silent-side-effect trace. For type safety, augment `MarkerData` registry (same pattern as `MatbotServices`).

---

## Plugin hot-reload

Reload from disk without restart (`plugin reload`; `loadPlugins(..., bustCache = true)`). Freshness all the way down:

- **Core stamps intent:** `toFreshUrl` adds `?mbfresh=<gen>` to plugin entry URL
- **Node resolve hook propagates:** `apps/cli/ts-hooks.js` cascades stamp through first-party imports
- **Boundary stops at host-shared singletons** (`@matatbread/matbot-core`, `@matatbread/matbot-plugin-api`) — re-stamping these breaks `instanceof` and shared state

**Caveats:** every reload leaks its subtree (ESM module registry never evicts); acceptable because reloads are rare. Not for per-request/timer use. All shared state must go through `services`, not shared module imports.

---

## Code style

- No provider SDKs
- No comments explaining *what*; only non-obvious *why*
- No trailing summaries, no docblocks
- No premature abstractions — three similar functions beat one leaky abstraction. This is about avoiding speculative/leaky interfaces, not a license to duplicate: a small, stable, already-shared utility (e.g. an `AsyncIterable` broadcaster) belongs in `plugin-api` once a second package needs it, not copy-pasted
- No error handling for impossible cases; trust discriminated unions
- Validate only at system boundaries
- `types: ["node"]` explicit in any tsconfig using Node APIs

---

## Changelog

`CHANGELOG.md` records **functional** changes only. Omit stylistic, refactoring, docs-only merges.

**Sections:** `## Unreleased` → `## Previously`. Within each, four categories in order:
1. **Breaking changes** — core contract changes
2. **API gaps filled** — new core API surface
3. **Bug fixes** — core fixes
4. **Optional** — new/updated plugins/frontends/apps, grouped by plugin