# matbot — Design Principles

Authoritative guide for anyone (human or LLM) working on this codebase.

---

## What matbot is

A TypeScript AI harness — a thin, composable runtime connecting language models to tools and frontends. Infrastructure, not a product.

---

## Hard constraints

**No provider SDKs.** All LLM communication uses `fetch` with SSE parsed via `parseSSE` from `@matatbread/matbot-core/providers-base`. Never import `@anthropic-ai/sdk`, `openai`, or equivalents.

**No Node primitives in shared packages.** Shared packages — `plugin-api/`, `core/`, and `plugins/*` (except those suffixed `-node`) — must run in Node and browser. Use `fetch`, `crypto.randomUUID()`, `AbortController`, `ReadableStream`, `TextDecoder`, `SubtleCrypto`. Never use `require`, `Buffer`, `EventEmitter`, `fs`, `path`, `child_process`, `os`, or `process.env`.

Secrets and configuration go through the `Vault` (`${NAME}` placeholders) or plugin `Settings` — both have swappable backends. Reaching for `process.env` directly is non-portable.

**AsyncIterators, not callbacks.** Streaming flows through `AsyncIterable<T>`. Never `EventEmitter` or raw callbacks for inter-layer communication.

**Strict TypeScript.** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Optional fields require conditional spreads; array/map indexing returns `T | undefined`; prefer `throw` over `process.exit(1)`; use `switch` exhaustiveness on discriminated unions.

---

## Architecture

### Monorepo layout
```
plugin-api/        — @matatbread/matbot-plugin-api: MatbotPlugin, MatbotServices/MatbotRuntime/
                     MatbotMachine, shared types, principal carrier, errors. The singleton contract;
                     every plugin peer-depends on it. Its own package (never folded into core).
core/              — @matatbread/matbot-core: agentic loop, hook dispatch, plugin loader, config
                     (YAML + .env), security (VaultImpl, Principal origin), knowledge
                     (LookupKnowledgeIndex). Author-facing subpath exports — link against without
                     pulling the runtime:
                       ./providers-base — SSE parser, HTTP helpers (write a provider)
                       ./storage-base   — filter/sort engine, StoreQuery (write a storage backend)
plugins/
    tool-plugin/   — built-in provider/plugin management tools (node)
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
    storage/
      filesystem/    — FilesystemStore (Node, CAS-safe); CLI boot default
      sqlite/        — SQLite StorageBackend (WAL)
      google-drive/  — Drive-backed StorageBackend (browser)
apps/
  cli/             — interactive REPL + single-turn
  web-bundle/      — browser-only matbot.html
```

**Dependency direction:** `apps` → `plugins/*-node` → `plugins/*` → `core` → `plugin-api`. Nothing in `plugin-api/`, `core/`, or `plugins/` may depend on `apps/`.

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
    module: @matatbread/matbot-provider-anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-4-6
    credentials:
      apiKey: ${ANTHROPIC_API_KEY}
    parameters:
      maxTokens: 4096
```

- `module` is the adapter's **package name** — the location-independent form, resolvable whether matbot is installed (`node_modules`) or run from a source checkout (the CLI's own install; see `resolvePluginSpecifiers`). A relative path (`./plugins/providers/anthropic`) also loads but isn't portable, so the setup wizard and the `provider` tool always write the package name when it resolves. This is the form to prefer.
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

`MatbotMachine` is the runtime environment passed to every plugin's `setup()` — the intersection `MatbotServices & MatbotRuntime`. **`MatbotRuntime`** is the fixed plumbing (hooks, tools, complete, settings, sessions, createStore, and the registry API itself): always present, never registerable. **`MatbotServices`** is the registry bucket — the swappable, registerable services keyed by interface name (`StorageBackend?`, `Vault`, `KnowledgeIndex`, plus whatever plugins augment in). It alone is the `keyof` domain of `register`/`get` and the surface third-party plugins augment, so `register('hooks', …)` is a *type error*. Optional services are advertised with `register` and consumed as **members** — one access surface:

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

**Swappable core members** (`StorageBackend`, `KnowledgeIndex`, `Vault`) use `register` to swap live impls behind capture-safe forwarding proxies. A captured reference keeps resolving to the current impl. On `unregister` (i.e. when the providing plugin is unloaded) a swap-member **reverts to the host's captured boot default** rather than dangling on the gone impl — the app decides its own base services (the CLI: filesystem or in-memory; the browser: OPFS), and the registry only remembers and restores them. The host's boot default is captured **before** any storage-plugin pre-scan, so a config-supplied backend never poses as the base; a pre-scanned backend is recorded as plugin-owned, so unloading its plugin reverts to that base.

### Context switch & the deferred StorageBackend swap

`StorageBackend` is the system of record: swapping it under a running turn would split a compare-and-swap across two backends. So `register('StorageBackend', …)` (and its `unregister` revert) is **deferred**, not immediate — it stages a last-write-wins pending slot and applies it at the next **quiescent edge** (no turn/request/message in flight). The other swap-members (`KnowledgeIndex`, `Vault`) repoint immediately.

A **context switch** is the machine analogue of an OS one — "page in pending machine state, then set the owner." `runAs(principal, fn)` is the bare *set-the-owner* primitive (the principal carrier stays a pure identity primitive); `contextSwitch(principal, fn)` layers the machine half on top, running host-registered flushers (`onContextQuiesce`) at depth-0 edges. The principal scope counter *is* the quiescence signal — the two concerns share call sites, not code. **The pump turn** (the CAS transactional unit) switches context; web/telegram entry points stay `runAs` (their request/message scope spans a long-lived SSE stream, so they must not count as a busy edge).

### The mount table (`services.mounted`)

A plugin reacts to a registry service (re)mounting or being unloaded through **`services.mounted`** — a `Mounted` whose one method, `consume({ key, replay?, signal?, onUnmount? }, handler)`, is keyed on the service it cares about. The host batches mount notifications to the **quiescent edge**: `register`/`unregister` mark a key dirty; the edge computes each key's net presence transition and **multicasts** to that key's subscribers. A reload (unregister+register before the edge) collapses to a single **remount**; an unregister not replaced by the edge is a **committed unload**, delivered to `onUnmount`. The contract guarantees only *eventual, ordered* delivery per key — **it says nothing about timing** (a register is not observably inline, nor pinned to a turn boundary). `StorageBackend`'s swap also lands at the edge (CAS coherence); other keys repoint immediately but still notify at the edge.

**Litmus — does a plugin need it?** Only if its `setup()` reads another service's *current state* to build cached/derived state. A pure map (no setup data; data arrives later as a tool call or hook) resolves its dependency per-invocation through the proxy/member and subscribes to nothing.

```ts
// cache the backend's documents; rebuild on every swap (initial load was in setup(), so no replay)
await manager.load();
services.mounted.consume({ key: 'StorageBackend', signal: manager.signal }, () => void manager.load());

// depend on a peer service that may arrive later; seed now if present (replay) and on each remount
services.mounted.consume({ key: 'SkillManager', replay: true, signal }, m => seed(m));   // m.SkillManager narrowed present
```

`replay` fires the handler on the next microtask against the current machine if the key is present (the deferred-dependency latch); handlers must be idempotent (a remount re-fires). A cacher that reads straight through a store proxy on each call (e.g. `persist-ki-bge`) needs no subscription — the proxy already follows the swap.

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
| `screen`     | once per turn, before 1st provider call | read-write | replace `session`, add `ephemeral` context (tail of outgoing messages, never persisted), add `durable` context (folded onto the user turn — persisted + visible — and carried live as `robo-user`), append durable `markers`, and/or `abort` |
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
  conditions: { kind: 'ephemeral' | 'contextual' | 'retract' | 'followup'; rule: string }[];
  invoke: { tool: string; params?: unknown };
  enabled?: boolean; createdAt; updatedAt;
}
```

**Triggers name a *tool*, not a skill.** "Apply a skill" is `invoke: skill_action({ action: 'use', … })` — a specialization, not a special case.

**Conditions are OR; `invoke` is the consequence.** Each condition is an LLM-judged rubric. `kind` determines surface judged, hook used, and delivery — two user-surface kinds (an ephemeral/durable pair) and two agent-surface:
- **`ephemeral`** — judge user message in `screen` hook; inject for this turn only (never persisted)
- **`contextual`** — judge user message in `screen` hook; fold durably onto the user turn (`origin: 'robo'`, persisted + visible via the `screen` result's `durable`, carried live as `robo-user`)
- **`retract`** — judge assistant response in `followup` hook; pop and re-run
- **`followup`** — judge assistant response in `followup` hook; resubmit as robo turn

The user-surface kinds were one kind named `augment` (= today's `ephemeral`); stored triggers migrate `augment`→`ephemeral` on plugin load.

**Observational dispatch:** tool's output is the signal. A `result` → inject; no result → silent side-effect. The dispatcher is a dumb transport — tools frame themselves.

**Fails soft.** Absent tool → nothing happens. Conditions evaluated by a classifier provider (Settings-resolved, falls back to turn's provider). Zero config required.

**Orthogonal to skills.** Skills own content; triggers own conditions and firing. A skill is fired only by a trigger naming it.

---

## Tool design — multi-action tools

**Preferred:** collapse related operations into one tool with an `action` discriminator. One description teaches the domain once; the per-action contract lives in the `ToolContracts` arms (below) and is rendered on the wire; `inputSchema` loose (`required: ['action']`), executor enforces. Use when operations share a domain or parameter shape.

**Keep separate:** genuinely standalone tools (`http`, `bash`, `ask_user`) or qualitatively different concerns (telegram's `send`/`provider`/`open_door`).

**Cross-references** may only point down the dependency graph — never to optional dependents.

**Typed contract — single source.** A tool's call contract lives in ONE place. **If the tool has scannable source, that place is its `ToolContracts` augmentation** (same pattern as `MarkerData`), keyed by tool name: a union of `ToolContract<Result, Params>` arms — one arm per action for a multi-action tool, a single arm for a single-action one — each pairing a result with the **full** params for that action (the discriminant lives *inside* the params, not as a separate pattern). Even a single-action tool uses an arm (`name: ToolContract<Result, Params>`), never a bare `name: Result` — the bare form yields no callable `ToolProxy` signature. From this single source everything derives:
- the executor binds `ToolExecutor<ToolResultOf<'name'>>` (compiler checks the yields);
- callers recover the result via `invokeTool` + `toolResult` (`ToolResultFor` narrows by the call's params);
- the injected `tool` proxy that code generators (`function-tools`, compiled skills) call is typed `ToolProxy` — each arm becomes a call-signature **overload**, so `await tool.name(params)` narrows its result by the params, plus a trailing catch-all (params-union → result-union) that keeps meta-types sound (`ReturnType<typeof tool.x>` degrades to the full union, never an arbitrary arm — a measured codegen trap) and makes dynamic union dispatch callable. The overloaded form is what makes generated tool-call code reliable first-try across model tiers (see the tool-typing probe: a single-signature/union proxy produced model-fragile and even silently-broken codegen);
- the flat wire `params`/`result` text is flattened back from the arms by `ToolTypeIndex.wireContracts()` and folded into the outgoing tool descriptions at the turn's dispatch edge (`session-runner`) — nothing hand-authored on the wire;
- generated code is graded by ONE checker (`@matatbread/matbot-tool-types` `checker.ts`): the TypeScript compiler API in a worker thread (never on the main loop; deliberately NO fallback path — a checker failure is a plumbing bug and must surface). Two entry modes: `checkProjectDir` (a compiled plugin's build dir — the skills compiler's repair loop) and `checkSnippetAgainst` (ambient dts + snippet — `ToolTypeIndex.check`, grading `function-tools` lambdas). Diagnostics return annotated for LLM repair (caret-anchored frames, related locations, directed HINTs, cascade capping) and include the structural **cast gate**: `as any`, `as unknown as T`, and checker-verified widening of an already-typed value to a loosening target are rejected exactly like type errors — a cast is the one hole through which a hallucinated shape survives to runtime, so it is closed deterministically, not by prompt prose.

**If the tool has NO scannable source — its name and/or shape are built at runtime** (a `function-tools` function, the `tool-store` per-namespace CRUD tool) — it can't carry a static augmentation, so it declares its contract on the registered `Tool` as a single `toolContract` **string**, identical in shape to a `ToolContracts` arm (`'ToolContract<Result, Args>'`, or a `|`-union of arms). The `ToolTypeIndex` splices it into the generated dts's `ToolContracts` (rewriting bare `ToolContract` to an inline `import(...)` so the block stays self-contained) and derives the wire text from it, exactly as it does a source tool's arms.

There are **no** `paramsType`/`resultType` fields — they are fully retired. A foreign tool (e.g. an MCP proxy) that carries neither an augmentation nor a `toolContract` falls back to its loose `inputSchema`, and the registry block emits `ToolContract<unknown, unknown>` so it stays in `keyof ToolContracts` (hence callable, loosely, through `ToolProxy`). Unregistered ⇒ `unknown`.

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