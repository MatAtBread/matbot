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
                       ./host — boot assembly for an EMBEDDER, not a plugin: carrier installers,
                                swap proxies, the mount table's producer half, HookRegistry,
                                createNotifier, the broadcaster. See "The /host boundary" below.
core/              — @matatbread/matbot-core: agentic loop, hook dispatch, plugin loader, config
                     (YAML + .env), security (VaultImpl, Principal origin), knowledge
                     (LookupKnowledgeIndex). Author-facing subpath exports — link against without
                     pulling the runtime:
                       ./providers-base — SSE parser, HTTP helpers (write a provider)
                       ./storage-base   — filter/sort engine, StoreQuery (write a storage backend)
plugins/            — one directory per package, flat but for the frontend/providers/storage groups
    tool-plugin/   — ALL of node's plugin support (node): the acquisition library the host drives,
                     plus the `plugin`/`provider` tools over it. See "Acquisition vs. management" below
    rumsfeld/      — contextual_search + find_fact tools; knowledge fault handler
    persist-ki-bge/— persistent KnowledgeIndex + BGE reranker
    triggers/      — data-driven hooks (condition → tool invocation)
    skills/        — skill CRUD + catalogue (cross-runtime)
    skills-node/   — node specialization: .md import/watch
    skills_compiler/— compiles a procedural skill into a TS tool plugin
    function-tools/— tool_function: TS lambdas/named tools composing registered tools
    tool-types/    — ToolTypeIndex: derives the tool dts + hosts the codegen checker (node)
    tool-router/   — ToolPresenter: bounded per-turn tool window + tool_search
    tool-store/    — store_action: named persistent stores with generated CRUD tools
    edit-session/  — session_edit tool (cut/fork/split/compact)
    sessions/      — session_action: list/get/rename/hide
    cognition/     — inner voice, remembered facts, dream_time consolidation
    provenance/    — determine_provenance: trace a claim to its evidence
    json-validation/— toolcall hook validating inputs against inputSchema
    files/         — file codec and producer registry
    hook-logger/   — diagnostic: logs every hook channel
    browser/       — IndexedDB store, OPFS files, WebCrypto vault (browser)
    web-principal-user/— WebPrincipalResolver bound to the host OS user
    bash/, docker-bash/, http/, workspace/, background/, ask-user/, whoami/
                   — the standalone tool plugins (no `tools/` grouping directory)
    mcp-http/      — HTTP/SSE MCP servers (cross-runtime); mcp/ adds stdio (node)
    frontend/
      web/         — HTTP+SSE server (node) + in-process (browser)
      dom/         — minimal in-process browser chat
      telegram/    — Telegram bot frontend
    providers/
      anthropic/   — Anthropic Messages API adapter
      openai-compat/— OpenAI-compatible adapter (+ opt-in `gemini` mode)
      google/      — Google Gemini adapter (native generateContent; OpenAI-compat fallback by endpoint path)
      customer-services/, chatjimmy/ — keyless demo/comparison endpoints
    storage/
      filesystem/    — FilesystemStore (Node, CAS-safe); CLI boot default
      sqlite/        — SQLite StorageBackend (WAL); compiles StoreQuery to SQL (the pushdown example)
      google-drive/  — Drive-backed StorageBackend (browser)
      profiles/      — per-principal partitioning over filesystem (node); profile_action, share
apps/
  cli/             — interactive REPL + single-turn
  web-bundle/      — browser-only matbot.html
```

**Dependency direction:** `apps` → `plugins/*-node` → `plugins/*` → `core` → `plugin-api`. Nothing in `plugin-api/`, `core/`, or `plugins/` may depend on `apps/`.

### Acquisition vs. management

Plugin **management is core's** — `loadPlugins` plus the registry own the whole lifecycle: the pre-import
runtime gate, the import, shape verification, identity stamping, register + setup, rollback, the failed
list, name↔specifier mapping. Nothing about that is in a plugin, and core depends on nothing but
`plugin-api`.

Plugin **acquisition is `tool-plugin`'s**: turning a config string into something importable —
`classifySpecifier` (local / npm / http), materialising an http plugin into `.plugins/`, provisioning a
local one's dependencies with npm, reporting a duplicated singleton. It cannot live in core, because every
line of it is `node:fs`, `node:child_process`, `createRequire` and symlinks, and **core must run in the
browser**. The browser's own acquisition is `apps/web-bundle`'s bootstrap (fetch → type-strip → `blob:`),
and both hosts hand the neutral loader the same pre-resolved `{ spec, importSpec }`.

So `tool-plugin` deliberately holds two things with two audiences: **the acquisition library, whose main
consumer is `apps/cli`'s boot and not the tools at all**, and the LLM-facing `plugin`/`provider` tools.
That is not drift awaiting a split — one half without the other has no use, and a package per concern would
buy a name at the cost of a package. Expect to find ~800 lines in here that no tool calls.

The seam a future split would use already exists and is deliberately short of acquisition:
`PluginResolver` (`plugin-api/src/plugin.ts`) is the host-injected `identify`/`version`/`runtimes`, for
exactly the reason above — host-specific, so injected rather than in the neutral core. Extending it with
`acquire()` is the shape to reach for IF a second node host ever needs acquisition without the tools.

### The `/host` boundary

`plugin-api`'s root answers exactly one question: **what does a plugin need in order to be a plugin?** Anything whose audience is an *embedder standing a machine up* lives behind `@matatbread/matbot-plugin-api/host` — carrier installers (`installPrincipalCarrier`, `installUsageCarrier` and the platform carrier factories), the capture-safe swap proxies (`forwardingProxy`, `makeSwappable`), the mount table's producer half (`createMountTable`, `MountTable`), the quiescent-edge machinery a host needs (`machineBusy`, `contextSwitch`, `quiesced`, `scheduleAtEdge`), `unifyServices`, `singleTurnRequest`, `HookRegistry`, `createNotifier`/`scopedNotifier`, and the `Broadcaster` primitive. `core` re-exports all of it, so an app depending on core needs no direct `/host` import — and no plugin in this repo imports any of it.

**It is a file boundary, not an export list**, so it cannot quietly erode: host assembly lives in `host-machine.ts`, and `index.ts` uses `export type *` plus a named value list for the two files that are deliberately split down the middle. Four subsystems are split rather than moved whole, because each has a real author-facing half:

| Subsystem | Root (plugin) | `/host` (embedder) |
|---|---|---|
| principal  | `runAs`, `currentPrincipal`, `tryCurrentPrincipal` | `installPrincipalCarrier`, `enterPrincipal`, `createConstantPrincipalCarrier` |
| notifications | `Notifier` type, `notifyingStore`, `ItemChangeKind`/`RegistryChangeKind` | `createNotifier`, `scopedNotifier`, `Broadcaster` |
| mount table | `Mounted`, `MountConsumeOptions`, `MountedMachine` (the contract of `services.mounted`) | `MountTable`, `createMountTable` (driven by register + the quiescent edge) |
| quiescent edge | `onContextQuiesce`, `Quiescer` — defer work to the next safe moment | `machineBusy`, `contextSwitch`, `quiesced`, `scheduleAtEdge` |

Fan-out is the one place the split implies a rule rather than just a location: a plugin that wants to publish an event uses the **`Notifier`**, which is why the raw broadcaster is host-side.

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

**Provider round-trip metadata (`ProviderMeta`).** Some providers require an opaque token to be echoed back verbatim when a tool-call is replayed in history — e.g. Gemini 3 "thought signatures", mandatory on every historical `functionCall` or the request 400s. This rides on a tool-call's `meta?: ProviderMeta` (on both `CompletionEvent` and `MessageContent`). `ProviderMeta` is an empty, **augmentable** interface (same idiom as `MatbotServices`/`MarkerData`): a provider package declares its own namespaced slice from its own module (`interface ProviderMeta { google?: { thoughtSignature?: string } }`), so core carries `meta` opaquely — stores, renders, or elides it — and **never changes when a provider adds round-trip state**. It's interface augmentation, not a generic parameter, because one session interleaves tool-calls from many providers. An adapter replays a token only when the message that produced it came from the *current* provider (a foreign token is elided/degraded, never posted into a slot it doesn't belong in).

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

## Open-registry augmentation

**Five extension points, one technique** — the most distinctive thing about matbot's API, and previously explained five times in five places. Each is an empty (or near-empty) interface in `plugin-api` that a package adds a key to via `declare module`; declaration merging accumulates every loaded plugin's contribution, so `plugin-api` never changes and never learns that the package exists. Helper types derive the real shapes from the merged registry.

| Registry | Key | Value | Home |
|---|---|---|---|
| `MatbotServices` | interface name | `Foo?: Foo` | `plugin.ts` |
| `ToolContracts` | tool name | `ToolContract<Result, Params>` arms | `types/tools.ts` |
| `Notifications` | `<package-name>#<InterfaceName>` | the notification shape | `notify.ts` |
| `MarkerData` | marker creator | the `data` shape | `types/messages.ts` |
| `ProviderMeta` | the package's namespace | its round-trip state | `types/provider.ts` |

Four consequences follow from the technique, and account for most of the per-registry rules stated elsewhere in this document:

1. **The key is the type's identity** — there is no runtime type information at these boundaries, so the string *is* the erasure-time stand-in. Name it after the thing, never a role. `Notifications` qualifies with a package name because a `kind` is globally scoped and an importer cannot rename it out of a collision.
2. **Open at runtime** — a plugin this build never compiled against, or a bridged remote, can contribute a key. Always `default` a `switch`; exhaustiveness checking over these is unsound.
3. **Absence is a type** — `?:` is the whole mechanism by which "may not be loaded" reaches a call site. Degrade; never fall back to loading it (*Discovery vs. direct dependency*).
4. **Unregistered ⇒ loose, not broken** — an unknown tool name yields `unknown`, an unregistered marker creator `data: unknown`. Base types stay permissive so the unions still work.

The author-facing version is `docs/DEVELOPING.md` *Open-registry augmentation*; each of the five declarations points at it rather than restating it.

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
type MediaStore   = FileStore;      // session media; see Media
```

**Swappable core members** (`StorageBackend`, `KnowledgeIndex`, `Vault`, `Notifier`) use `register` to swap live impls behind capture-safe forwarding proxies. A captured reference keeps resolving to the current impl. On `unregister` (i.e. when the providing plugin is unloaded) a swap-member **reverts to the host's captured boot default** rather than dangling on the gone impl — the app decides its own base services (the CLI: filesystem or in-memory; the browser: OPFS), and the registry only remembers and restores them. The host's boot default is captured **before** any storage-plugin pre-scan, so a config-supplied backend never poses as the base; a pre-scanned backend is recorded as plugin-owned, so unloading its plugin reverts to that base.

### Context switch & the deferred StorageBackend swap

`StorageBackend` is the system of record: swapping it under a running turn would split a compare-and-swap across two backends. So `register('StorageBackend', …)` (and its `unregister` revert) is **deferred**, not immediate — it stages a last-write-wins pending slot and applies it at the next **quiescent edge** (nothing holding the machine — in practice, the pump's queue drained). The other swap-members (`KnowledgeIndex`, `Vault`) repoint immediately.

A **context switch** is the machine analogue of an OS one — "page in pending machine state, then set the owner." Two primitives, one per half: `runAs(principal, fn)` sets the owner (the principal carrier stays a pure identity primitive), and `machineBusy(fn)` holds the machine, running host-registered flushers (`onContextQuiesce`) at the release edge. `contextSwitch(principal, fn)` is simply both, for an operation that is both. The hold is a *wrapper*, never a `begin`/`end` pair: it releases on every exit including a throw, and a stranded counter is unrecoverable — every later flush would no-op forever, with no symptom but a deferred mutation that never happens.

**Scheduling edge work is one call.** `onContextQuiesce` registers *and announces*, so the barrier engages and the edge is guaranteed to arrive — a one-shot is `onContextQuiesce(un => { un(); work() })` (the closure holds the work; no pending flag), and a standing flusher is the same without the `un()`, which then MUST be idempotent since it runs at every edge. Repeated announcements that should collapse into **one** apply — the host's staged `StorageBackend` swap, a dirty mount key — use `scheduleAtEdge(work)`, a guarded one-shot: the guard coalesces the stagings and the work reads a last-write-wins slot, so three registers before an edge install one backend rather than three in turn. Continuous delivery is a *standing registration*, never a callback re-registering itself — registering means "I have work now", so a self-re-registering callback would announce fresh work from inside the sweep answering the last lot and re-enter forever; there is no independent clock to wait for. `onContextQuiesce` is a *subscription* (ask twice, run twice — each call carries its own work); `scheduleAtEdge` is a *dirty flag* (poke it N times, run once, reading a slot at fire time). `flushIfQuiescent` is private: announcing is what registering does, so exposing "force an edge" only offered callers a way to reason about firing that they should not need. Registering also schedules its own edge attempt on a microtask, never inline: a callback must not run before the statement registering it has returned.

**A flusher may suspend the edge.** `onContextQuiesce` takes `(un) => void | Promise<void>`; returning a promise makes the edge *wait*. Flushers are invoked in registration order and then settle together; the synchronous prefix runs inline, so synchronous work registered on an idle machine is in effect by the time the sweep returns. Serialising flushers against *each other* is deliberately not done — it would remove one source of concurrent mutation and leave every other, at the price of every flusher waiting on the slowest.

**The edge is a barrier, not a counter — for liveness, not for coherence.** `machineBusy` waits for staged work to land before taking the hold, so a flusher runs with the machine to itself for its whole extent (an entrant can no longer walk in through a flusher's `await`). The reason is *not* CAS coherence: that belongs to `mediumGuard`, which fails a write whose read came from another backend on the version stamp, and to the `Store`'s own CAS — contention over a service is the service's to resolve. It is that **a counter cannot force `depth` to reach zero**. Under continuously overlapping holds — several sessions on a busy server, each pump holding across its own queue — the edge never arrives, and a deferred session edit that never lands and a staged swap that never applies are both failures with no symptom. Barring entry is the only way to make the drain reachable.

The wait lives *inside* `machineBusy` rather than at the call site, for the reason `runAs` is ambient and a mount interest is bound to its plugin's load extent: spelled outside, a second caller who omits it gets no error and no symptom, just work that stops landing. It is **bounded** (one constant, then it proceeds with a warning), because a counter cannot distinguish a nested entrant from a concurrent one — an LLM reaching a matbot HTTP endpoint through its own `http`/`bash` tool is inside its own turn's hold, and would otherwise wait on a drain that includes itself. Telling the two apart needs a hold-identity carrier and the platform split that implies; the bound degrades to the pre-barrier behaviour instead of hanging. `quiesced()` remains for an operation that needs deferred work complete without holding the machine; the pump no longer calls it.

**What holds the machine is the operation, not the turn.** The pump holds it across its **whole queue** and `runAs`es per item, because the pump's own store work does not stop at a turn's end: it reads the committed document back for `followup`, appends markers to it, rewrites it for a retract, and persists the next turn's user message before that turn opens. A per-turn hold declared all of that idle — six edges fell inside one two-turn queue — so a mutation could land in precisely the gap the deferral exists to close. The queue draining is the real boundary, and it is the one accounting already flushes at, for the same stated reason: "the end of a turn" is not a moment anything can be totalled or swapped at. Entry points that *receive* work without performing it — a web request holding an SSE stream open, a telegram message — stay `runAs` and are deliberately not busy; counting them would mean the machine never reaches an edge at all.

### The mount table (`services.mounted`)

A plugin reacts to a registry service (re)mounting or being unloaded through **`services.mounted`** — a `Mounted` whose one method, `consume({ key, replay?, signal?, onUnmount? }, handler)`, is keyed on the service it cares about. The host batches mount notifications to the **quiescent edge**: `register`/`unregister` mark a key dirty; the edge computes each key's net presence transition and **multicasts** to that key's subscribers. A reload (unregister+register before the edge) collapses to a single **remount**; an unregister not replaced by the edge is a **committed unload**, delivered to `onUnmount`. The contract guarantees only *eventual, ordered* delivery per key — **it says nothing about timing** (a register is not observably inline, nor pinned to a turn boundary). `StorageBackend`'s swap also lands at the edge (CAS coherence); other keys repoint immediately but still notify at the edge.

**The table is the in-process half; the bus is the other.** Each transition is *also* published as a
`RegistryChange` on the `services` registry (`name` = the `MatbotServices` key, a remount reading as
`added`) — because a swapped `StorageBackend` writes nothing, so `notifyingStore` announces nothing, and
every document in every namespace silently starts coming from somewhere else. No `ItemChange` can say
that: it addresses one item. It is published **after** that key's handlers settle and **whether or not
any exist** — the handlers are how the caches a remote reader queries *through* get rebuilt (announcing
first invites the stale read the announcement exists to end), and the interests map holds this process's
plugins, which says nothing about who is listening on the bus.

**Litmus — does a plugin need it?** Only if its `setup()` reads another service's *current state* to build cached/derived state. A pure map (no setup data; data arrives later as a tool call or hook) resolves its dependency per-invocation through the proxy/member and subscribes to nothing.

```ts
// cache the backend's documents; rebuild on every swap (initial load was in setup(), so no replay)
await manager.load();
services.mounted.observe({ key: 'StorageBackend' }, () => void manager.load());

// depend on a peer service that may arrive later; seed now if present (replay) and on each remount
services.mounted.observe({ key: 'SkillManager', replay: true }, m => seed(m));   // m.SkillManager narrowed present
```

`replay` fires the handler on the next microtask against the current machine if the key is present (the deferred-dependency latch); handlers must be idempotent (a remount re-fires). A cacher that reads straight through a store proxy on each call (e.g. `persist-ki-bge`) needs no subscription — the proxy already follows the swap.

**An interest cannot outlive its owner.** The host binds every plugin-scoped `observe()` to that plugin's load extent, so `unloadPlugin` drops its interests with its tools and hooks. `signal` is therefore a *narrowing* option — "end this subscription earlier than my unload" (a per-session cache, a one-shot latch) — not the cleanup path. It was the cleanup path, and optional, which meant an author who omitted it left a live handler firing into a torn-down closure, one per reload generation, silently (the table logs and swallows a handler throw). Lifetime the host can know is the host's to enforce.

### Discovery vs. direct dependency

Registry is for **negotiation between independent parties** — consumer neither knows nor cares who provides a capability. Use `services.x` (with `?:` optional) only when absence is genuinely acceptable; degrade gracefully (`if (!services.x) return;`), no fallback.

When one plugin **specializes** another ("B *is* A, but broader"), that's an `extends` relationship — express it with a plain `import` + construct and hard `package.json` dependency. The moment you write `services.x ?? loadPlugin(x)`, the dependency isn't optional. **Offer loosely; depend tightly.**

---

## Knowledge subsystem

`KnowledgeIndex` is a **core** service. Default: `LookupKnowledgeIndex` (in-memory, term frequency). `persist-ki-bge` replaces it with `Store<KnowledgeEntry>`-backed persistence + optional BGE reranker. `rumsfeld` registers `contextual_search` tool — the primary consumption path. `register('KnowledgeIndex', impl)` swaps at runtime.

---

## Storage

`Store<T extends { id: string; version: string }>` — universal interface. All writes use compare-and-swap (`store.cas(id, expectedVersion, next)`). Never write without version check when concurrent updates are possible.

`createStore` is addressed BY name, so **`StorageBackend.namespaces?()`** is the other half: what a backend
currently holds, without which nothing can traverse one (copy, audit, report). Optional because absence
is a type — a medium with no listing operation must degrade, not guess. Never implement it as "the
namespaces `createStore` was called with this session": that is a lower bound wearing an answer's
clothes. Files are a separate axis (`FileStore.list`), never a namespace.

**Exactly one backend is active.** The boot pre-scan opens the first configured plugin offering a
`storageBackend` and stops; a plugin registering one later displaces it at the quiescent edge. Nothing
is migrated between them, so a discarded backend has typically already created its file — the host
warns once, naming the plugin, because the failure is otherwise silent and reads as "my backend is
configured and does nothing".

**A write may not cross a swap** (`mediumGuard`, in `core/storage-base`, wrapped around each store
proxy by the host). Since nothing is migrated, a caller that read a document before a swap and writes
it after is addressing two media with one read-modify-write, and neither end can tell: `cas` asks "did
this document change?", which the new backend answers about a document it never issued — usually
"there is nothing here", whereupon an unconditional `set` recreates the old backend's document inside
its replacement and the session has silently migrated. The version is the only token tying a read to
its write, so it carries the medium: stamped on the way out, checked and stripped on the way in (a
stamp must never persist — most write-backs reuse the version they read). An unstamped version is
always accepted; that is a document the caller minted, and a create has no earlier medium to
contradict. A stale `cas` reports the loss callers already handle, a stale `set` throws, having no
other channel.

**Partitioning/ownership is a backend CAPABILITY, not a layer over backends.** How data is divided by
owner is medium-specific — nested directories, a table prefix, a partition column, row-level policies —
so there is no general wrapper that could impose one composition on every backend. `ProfileDirectory` is
the shared surface, and consumers reach it by duck-typing the *active* backend
(`asProfileDirectory(services.StorageBackend)`, method presence, never `instanceof`, so it survives hot
reload and follows swaps). The check takes `unknown` and is purely structural: **any** backend exposing
that shape is picked up, with no import and no plugin-api change — which is why the contract does not
need hoisting out of the plugin that currently implements it. `storage/profiles` is one implementation,
the filesystem one; it composes `FilesystemStorageBackend` directly rather than wrapping the active
service, and therefore does not combine with SQLite or any other backend.

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

**A scanned root supplies a tool's *contract*; only the live registry says the tool *exists*.** The dts scan roots at each loaded plugin's `resolvedUrl` and then UNIONs a glob of the monorepo `plugins/` tree onto it — not a fallback, but the only way to reach host-constructed builtins (`plugin`, `provider`) that have no `resolvedUrl` — so the roots are a **superset** of the loaded set by construction, reaching plugins for other runtimes and plugins nobody loaded. `buildMatbotToolsDts` therefore emits only the keys in `tools.list()`. A declared-but-unloaded tool is worse than an absent one: `await tool.telegram_send({ text })` typechecks clean against it and throws `not registered` at runtime — the one failure the check gate exists to prevent, and one the repair loop cannot repair, because the code is correct against the types it was shown. Contrast `MatbotServices`, which takes no such filter: absence there is already a type (the `?:` *is* the "may not be loaded" signal), whereas a `ToolContracts` key carries no such qualifier — declared means callable. What the filter cannot settle is two roots declaring one *live* name (`bash`, by `plugins/bash` and `plugins/docker-bash`): that still merges by Program file order, and is reported via `conflicts` rather than resolved.

---

## Thinking blocks (Anthropic)

When `parameters.thinking` is set, complete `{ type: 'thinking', thinking, signature }` blocks are stored and round-tripped verbatim. Never strip them.

---

## Notifications

`Notifier` is the one fan-out for every "something changed" fact — a swappable `MatbotServices`
member with an in-process host default. Matbot owns the **envelope and the registration surface**;
it does not own delivery (no persistence, replay, or guarantees — that's what a registered
distributed impl is for).

```ts
services.Notifier.notify({ kind: ItemChangeKind, source: 'skill', operation: 'saved',
                           namespace: 'skills', id, principal });
services.Notifier.consume(n => { … }, signal, n => n.kind === ItemChangeKind);
```

**Two discriminants, both filterable.** `kind` selects the payload shape (`ItemChange`,
`RegistryChange`, or an augmentation of `Notifications`); `instance`/`plugin`/`source` are
attribution. A sink filters on either or both. `plugin` is stamped from the emitting plugin's scope.

**`kind` is `<package-name>#<InterfaceName>`, and nothing declares it twice.** The `Notifications`
key *is* the tag — an arm never declares a `kind` field; `Notification` grafts the key on, so "the
tag matches the key" is unrepresentable rather than a convention to police:

```ts
export interface JobProgress extends NotificationBase { done: number; total: number }
export const JobProgressKind = '@fnarr/jobs#JobProgress' satisfies keyof Notifications;

declare module '@matatbread/matbot-plugin-api' {
  interface Notifications { '@fnarr/jobs#JobProgress': JobProgress }
}
```

Qualified because, unlike a type name, a `kind` is globally scoped and an importer *cannot* rename
it out of a collision — two plugins picking the same bare word is an unfixable declaration-merge
conflict in a file neither owns, and across a bridge it is a silent mis-narrowing. The package name
is already unique, so it does the qualifying; the exported const gives the renameable handle back.
The prefix names the package that **defines** the shape, never the one emitting it (`plugin` is the
emitter — four plugins emit `ItemChange`). Enforced by the `Qualified<K>` arm of `NotifyInput` at
the `notify` call, and warned about at runtime for producers TypeScript never saw. Do **not** use
the emitter/kind pair as a compound discriminant: relaying rewrites `plugin`, and one shape emitted
by four plugins would become four types.

**`kind` is open at runtime** — a foreign plugin or a bridged remote server can publish one this
build has never seen. Always `default` a `switch` over it; exhaustiveness checking is unsound here.

**Which kind do I publish?** `ItemChange` whenever the fact is "the thing addressed by
`(namespace, id)` is stale — re-read it", *whatever holds it*: a `Store` (via `notifyingStore`), a
`FileStore`, a share that passes through neither, a directory a plugin watches. It is deliberately not
named `StoreChange` — the medium is an implementation concern, and making a plugin author answer "is
my thing a Store?" to use the bus was the wrong first question. Define a kind of your own only when
you carry something a consumer **cannot** get by re-reading — progress, a measurement, an external
event. That is a new shape, not a new source; `detail` is not the place to smuggle it.

`RegistryChange` covers the three process-global registries — `tools`, `plugins` and `services` — where
there is no owner and no item identity, only a member gained or lost. The `services` arm is the mount
table's (above): it is the only way "the medium under every namespace was replaced" reaches a reader
outside this process.

**`namespace` is an address space, not a plugin.** It looks 1:1 with plugins from the web UI's
`switch`, and it isn't: `files` is emitted by workspace, by background (a detached job's output), and
by the profiles backend (a share); `sessions` has no plugin at all — the host wraps that store in
`notifyingStore`, behind which sit the turn pump, `session_action`, `session_edit` and the frontend;
and the profiles backend takes `namespace` as a *parameter*, announcing for every space, none of which
it owns. So a per-plugin `kind` cannot be derived — the emitter is not the owner — and it would
duplicate `plugin`, contradicting it exactly where it matters. Consumers reflect this: the visibility
filter and the tool-registry watchers dispatch on `kind` alone and never look at `namespace`. Only the
UI switches on `namespace` after `kind`, because it has a panel per space — its own layout concern, and
the reason a new space flows past `default` instead of breaking every consumer.

**`principal` is ownership, not attribution** — whose data changed, and the input to
`WatchVisibility.visible`. Never conflate it with the producer fields.

**Identity, never value.** An `ItemChange` carries `namespace`/`id`/`operation`; `detail` is
advisory (a cosmetic in-place UI update at most). Events are queued per subscriber and are stale
the moment a concurrent writer lands, so a consumer re-reads through the store. A sink attaching
mid-flight has missed what preceded it — **re-query on attach**; never put current state on the bus.

**Emit where the change happens**, not where a tool call happens: a detached child's completion and
an HTTP-created session are both real changes with no tool executor in scope.

**A private stream is not a second bus.** The tool registry, the plugin registry and the SkillManager
each had their own broadcaster over the same primitive; all three now publish onto the bus and have no
`watch()`. `FileStore.watch` went too — it existed to detect writes made *outside* matbot, which is a
plugin's job, not a core interface every backend must implement (two of four faked it with a stream
that yields nothing, making "cannot watch" indistinguishable from "nothing changed"). Matbot writes
`.data` and nothing else; anything richer — run a turn when a file arrives — is a plugin that watches
what it likes and publishes onto the bus, which `MatbotServices` already makes easy.

The one exception is `session-busy`: it replays current state on connect, which the bus refuses to
carry, so the frontend keeps it as its own SSE event.

**Distributed is left open, not built.** A registered `Notifier` may forward off-box; it stamps
`instance` on ingress and must not re-forward a foreign `instance` — that is the loop break.

## Accounting

matbot guarantees **fidelity and attribution**; semantics are a consumer's. Full reasoning in
`docs/ACCOUNTING-RATIONALE.md`.

A turn's activity is a **log of self-describing entries** (`TurnEntry`), anchored on the turn's **head**
(its user message) as `Message.activity` and read back with `turnActivity()` / `usageEntries()`:

- `{ kind: 'call' }` — one provider call: `provider`, `usage`, and its bracket.
- `{ kind: 'span' }` — a bracket matbot held open that was not a call of its own (a tool call). Separate
  because most tools spend no tokens, so timing hung off an accounting record would exist only for the
  tools that happen to call an LLM.

Every entry carries **`site`** (`round` / `tool` / `hook`) and the **causal `traceId`**. Those two are
the intrinsic part — facts about matbot's own control flow that no adapter and no plugin can recover
afterwards. Everything derived from them (cost, per-tool/per-user/per-task totals, what a "task" is) is
a *query plus a rate table*, and stays outside.

**Attribution is declared, never inferred from timing.** The site is captured where work *starts*, so a
classifier kicked off detached in `screen` stays attributed to that hook however late it settles.

**A turn is a coordinate, not a container.** Its end is not a well-defined moment to total anything at
— steers terminate and resume, a retract re-enqueues the turn it just popped, `followup` runs
post-commit — so entries flush **when the pump's queue drains**, and one still in flight lands on the
next idle. Anchoring on the turn head is what survives a retract-and-rerun: the pop stashes assistant
and tool messages inside a marker payload, out of reach of any reduction over `session.messages`.

**Adapters normalise for comparability and retain for fidelity.** `Usage` carries the normalised
counters *plus* `reported` — the endpoint's own `usage` object verbatim. The protocol determines shape,
and an adapter already owns a protocol, so there is no second normalising layer. Guard on **presence,
not truthiness**: a reported `0` and an absent key are different facts. Never synthesise a value the
endpoint did not send.

## Markers

Opaque, durable annotations in the message stream — `{ type: 'marker', creator: string, data: unknown }`. Stored as marker-role messages, **elided from LLM submission**, **persisted unchanged**, **preserved by compaction**. A tool emits one via `marker` `ToolEvent`; the triggers dispatcher collects and persists them for silent-side-effect trace. For type safety, augment `MarkerData` registry (same pattern as `MatbotServices`).

---

## Media

Two paths, no overlap, distinguished by **who owns the bytes**:

| | Carried as | Resolved by | Lifetime |
|---|---|---|---|
| **Tool media** — the model pulled it | nothing; wire-only | the runner, from the tool's `model-content` event | dies with the turn |
| **Session media** — a person attached it | a `file-ref` in the message | the runner, via `MediaStore` | dies with the session |

The runner therefore never guesses which store an id belongs to: it only ever resolves session media.
A model referring to a *workspace* file transfers no ownership and needs no new mechanism — it calls a
tool, which pulls (below).

### Tool media — the pull path

The model **pulls** media; nothing pushes it. A tool yields `{ type: 'model-content', content: ModelContent[] }` —
the inline arms of `MessageContent` (`image` / `document` / `audio`), bytes plus a mime type. The runner
pins them directly after the tool message they answer and splices them into the **outgoing copy** for
the rest of the turn. The mirror of a marker: a marker is persisted and invisible to the model; media is
visible to the model and never persisted.

**Never persisted** — the transcript records what a tool *returned*, not the bytes it *showed*, so a
session cannot accumulate base64 and no exit path has to remember to strip it. A later turn needing the
bytes calls the tool again.

**Rest-of-turn, not next-call-only** — withdrawing content the model has already seen breaks the prompt
cache from that point and leaves it referring to something no longer there. The cost corollary is real:
a large document is re-sent every subsequent round, so a tool hands over the smallest thing that answers
the question, and `maxRounds` bounds how often it is paid for.

**No `FileStore` dependency, by construction.** `files` is optional on both `RunSessionOpts` and
`ToolContext`, so routing media through it would make multimodal impossible without one. Core never asks
where a tool got the bytes — a `FileStore`, an HTTP fetch, a chart rendered in memory. Storage reads are
the tool's concern; the loop's concern is the wire.

Not a `PipelineEvent`: nothing durable backs it, so a frontend drawing it live would show something that
vanishes on reload. A tool that also wants the *user* to see something has `file` and `marker`.

### Session media — the push path

What a *person* attached. Bytes arrive **by value at the submission boundary** and are gone from the
message before it is enqueued: `open()` writes each inline arm through `MediaStore` and replaces it with
a `file-ref`. **What persists is always a reference** — the one absolute rule, with no exception to
police, because the alternative is measurable: `store.set` runs at turn start *and* at every turn end,
two whole-document writes plus a read, so a 5MB image is ~6.7MB of base64 riding every one of them for
the rest of the session.

By-value is a *boundary form*, not a wire format. It exists because Telegram has no upload-in-advance
leg and cannot have one — bytes arrive WITH the message. Doing it in `open()` means one place, and every
frontend inherits it; the web composer posts inline base64 in the submit body for the same reason, which
also dodges the pre-session draft-key problem (the client creates its session lazily on first send).

**`MediaStore` is an alias of `FileStore`**, registered under its own `MatbotServices` key. `FileMetaData`
already carries `sessionId`/`messageId`/`namespace`/`allowed` and `FileFilter` already filters on
`sessionId`, so session-scoped lifetime, per-message attribution and a servable flag are in the shape
already — which means every existing implementation (filesystem, SQLite, OPFS, Drive) is a candidate
media store *unchanged*, and media on one medium with sessions on another is a **registration, not a
port**. Two implementations of one interface get an alias, never an invented role name. A bespoke
`MediaResolver` was considered and rejected: it bought nothing the alias didn't, and left something to
implement.

Both hosts seed their own file area as the boot default, so attachments work out of the box; the seed
goes in the *registry* rather than on `baseServices`, because `unifyServices` resolves an own property
first and a member spelled there is one `register()` could never reach. Unregistering reverts to that
default rather than turning media off.

**Residency is a byte budget** (`MEDIA_RESIDENCY_BYTES`, 8MB), walked newest-first, computed **once per
turn**. Beyond it a `file-ref` is left alone and the converters degrade it to `[Attached file: x]` —
honest, already written, and the file is still fetchable. A byte budget rather than a turn count because
the cost is denominated in bytes: three turns is a fine window for a thumbnail and a ruinous one for a
40MB PDF, and a count cannot tell them apart. Recomputing per *round* would let a message fall out of the
window between two provider calls, busting the prompt cache and leaving the model referring to something
no longer there.

**Refuse at the boundary, naming the file** (`MediaRejectedError`, with `reason`). The alternative is a
provider 400 part-way through a turn the user already believes was sent, with no way back. Nothing is
enqueued on a refusal, so there is nothing to unwind. Caps: 20MB/file, 50MB/session — the session total
**derived** by summing what the store holds, never a counter, which is wrong after a restart, a swap, or
anything deleting a file behind it.

**`UserContent` is a narrow subset of `MessageContent`, deliberately.** A submission crosses a wire
boundary; widening it to the full union would let a client post a forged `tool-result`, `thinking` block
or `marker` straight into persisted history. The web server validates against a **whitelist** of the
arms, so an arm a later plugin-api adds is rejected rather than admitted by omission.

**Referential integrity is the storage backend's job.** Whether bytes physically live inline in the
session document or in a blob store is the `MediaStore` implementation's business and must not leak above
the door — which is why a text-only `StorageBackend` implements *nothing*, and `cut`/`fork`/`split`/
`compact` keep working: they move whole messages. Likewise, serving media over HTTP applies **no gate the
route invents**: `allowed` is a flag the store persists and the producer opts into per put, and area
routing is the backend's via `FilePartition`. Access control belongs to the layer implementing storage,
not the layer exposing it — a UI can lie about a principal.

Known-benign: a semantic back-reference ("that image I uploaded") cannot survive a `split` or a
`compact` that leaves the media on the far side. "I can't see any uploaded image" is the *correct* answer
there and is visible to the user. Structural integrity — bytes travelling with their message — is a
separate thing and is preserved.

Still open: sweep-on-session-delete has no contract, because `session_action` has no `delete` action to
hang one on. No leak today (media is `sessionId`-scoped and therefore enumerable); define it when a
delete exists.

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

**Sections:** one `## <version>` per release, newest first; work not yet versioned goes under
`## Unreleased` until the release it lands in is cut, then folds into that version's section. Within
each, four categories in order:
1. **Breaking changes** — core contract changes
2. **API gaps filled** — new core API surface
3. **Bug fixes** — core fixes
4. **Optional** — new/updated plugins/frontends/apps, grouped by plugin