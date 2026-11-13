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
core/              — @matatbread/matbot-core: agentic loop, hook dispatch, plugin loader, security
                     (VaultImpl, Principal origin), knowledge
                     (LookupKnowledgeIndex), boot assembly (`assembleMachine` — see "Boot
                     assembly" below), the default PermissionGate policy + `gate_action`
                     (`default-gate/` — see "Permission gates"). Author-facing subpath exports — link against without
                     pulling the runtime:
                       ./providers-base — SSE parser, HTTP helpers (write a provider)
                       ./storage-base   — filter/sort engine, StoreQuery (write a storage backend);
                                          MemoryStorageBackend (persists nothing)
host-node/         — @matatbread/matbot-host-node: what a Node HOST needs that core cannot hold, being
                     Node-only — the AsyncLocalStorage carriers, the TS-source module hooks (./register,
                     ./typescript-hooks), plugin loading from disk (nodePluginMembers), EnvFileVault. Not a
                     plugin, and assumes no config file, directory layout or way of acquiring plugins:
                     each piece takes the path it works on
plugins/            — one directory per package, flat but for the frontend/providers/storage groups
    rumsfeld/      — contextual_search + find_fact tools; knowledge fault handler
    persist-ki-bge/— persistent KnowledgeIndex + BGE reranker
    triggers/      — data-driven hooks (condition → tool invocation)
    skills/        — skill CRUD + catalogue (cross-runtime)
    skills_compiler/— compiles a procedural skill into a TS tool plugin
    function-tools/— tool_function: TS lambdas/named tools composing registered tools
    function-runner-node/— the node FunctionRunner: bounds a body, withholds host globals, routes its
                     imports onto the gate; function_runner_config reads and changes its time bound.
                     OPTIONAL and not in a default install — without it a body runs unbounded,
                     unshadowed and ungated
    gate-fs-node/  — puts each path a tool_function body's node:fs names to the gate (fs-read / fs-write /
                     fs-access),
                     through function-runner-node's ImportedModuleWrapper seam
    tool-types/    — ToolTypeIndex: derives the tool dts + hosts the codegen checker (node)
    caching-tool-types/— tool-types + its build persisted in settings across restarts (node)
    tool-router/   — ToolPresenter: bounded per-turn tool window + tool_search
    tool-store/    — store_action: named persistent stores with generated CRUD tools
    edit-session/  — session_edit tool (cut/fork/split/compact)
    sessions/      — session_action: list/get/rename/hide/append; read state (`Session.readAt`, added by
                     augmentation, so core carries none of it) and each session's `state` for a list
    session-data/  — session_data: intermediate results kept in a session as markers, read back by id
    cognition/     — inner voice, remembered facts, dream_time consolidation
    provenance/    — determine_provenance: trace a claim to its evidence
    json-validation/— validate hook checking inputs against inputSchema (cross-runtime)
    ts-validation/ — validate hook checking inputs against the ToolContract params type (node, via tool-types)
    hook-logger/   — diagnostic: logs every hook channel
    browser/       — IndexedDB store, OPFS files, WebCrypto vault (browser)
    web-principal-user/— WebPrincipalResolver bound to the host OS user
    background-jobs/— `background_job`/`background_job_action`: jobs that report by appending to a conversation,
                   run in-process on an ephemeral run (cross-runtime)
    background-jobs-node/— the same, each job in its own process (node)
    bash/, docker-bash/, http/, workspace/, ask-user/, whoami/
                   — the standalone tool plugins (no `tools/` grouping directory)
    mcp-http/      — HTTP/SSE MCP servers (cross-runtime); mcp/ adds stdio (node)
    frontend/
      web/         — HTTP+SSE server (node) + in-process (browser)
      telegram/    — Telegram bot frontend
    providers/
      anthropic/   — Anthropic Messages API adapter
      openai-compat/— OpenAI-compatible adapter (+ opt-in `gemini` mode)
      google/      — Google Gemini adapter (native generateContent; OpenAI-compat fallback by endpoint path)
      webllm/      — open-weight models on the GPU in the page via WebLLM, from a CDN (browser; prototype)
      customer-services/, chatjimmy/ — keyless demo/comparison endpoints
    storage/
      filesystem/    — FilesystemStore (Node, CAS-safe); CLI boot default
      sqlite/        — SQLite StorageBackend (WAL); compiles StoreQuery to SQL (the pushdown example)
      google-drive/  — Drive-backed StorageBackend (browser)
      profiles/      — per-principal partitioning over filesystem (node); profile_action, share
apps/
  cli/             — interactive REPL + single-turn; matbot.yaml (its schema and parser — core takes a
                     config, it does not read one); node plugin acquisition and the `plugin`/`provider`
                     tools, which edit matbot.yaml (src/plugins)
  web-bundle/      — browser-only matbot.html
examples/          — private, never published: programs using matbot as a dependency (minimal-matbot:
                     core alone, stdin → chatjimmy → stdout). They import published package names only
```

**Dependency direction:** `apps` → `plugins/*-node` → `plugins/*` → `core` → `plugin-api`, and `apps` → `host-node` → `core`. Nothing in `plugin-api/`, `core/`, `host-node/` or `plugins/` may depend on `apps/`, and no plugin imports `host-node`: it is for whoever stands a machine up. A storage backend lives in its plugin (`storage-filesystem`, `plugins/browser`, `storage-sqlite`), which a host imports to boot on. `apps/cli/test/core-alone.test.ts` and `embedder.test.ts` are a machine from core alone and from core + host-node + a storage plugin, each refusing to import anything else.

### Acquisition vs. management

Plugin **management is core's** — `loadPlugins` plus the registry own the whole lifecycle: the pre-import
runtime gate, the import, shape verification, identity stamping, register + setup, rollback, the failed
list, name↔specifier mapping. Nothing about that is in a plugin, and core depends on nothing but
`plugin-api`.

Plugin **acquisition is the CLI's** (`apps/cli/src/plugins`, and `apps/cli/src/specifiers.ts` for the
boot's resolution of configured specifiers): turning a config string into something importable —
`classifySpecifier` (local / npm / http), materialising an http plugin into `.plugins/`, provisioning a
local one's dependencies with npm, reporting a duplicated singleton. It cannot live in core, because every
line of it is `node:fs`, `node:child_process`, `createRequire` and symlinks, and **core must run in the
browser**. The browser's own acquisition is `apps/web-bundle`'s bootstrap (fetch → type-strip → `blob:`),
and both hosts hand the neutral loader the same pre-resolved `{ spec, importSpec }`.

It is the CLI's rather than a library's because every part of it is a CLI convention, not a platform
fact: the `plugin`/`provider` tools edit `matbot.yaml`, and acquisition writes `.plugins/` and installs
with npm beside it. An embedder that wants none of that loads what is already installed (resolving the
specifier itself — `import.meta.resolve` — and handing core `{ spec, importSpec }`); one that wants
plugins added at run time builds that against its own persistence, as the web bundle's bootstrap does with
`plugins/browser`'s `plugin` tool over a list in IndexedDB. The acquisition half's main consumer is the CLI's boot, not the tools.

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

### Boot assembly

**`assembleMachine` (core) is the one expression of the boot graph**: the swap-members and their boot
defaults, the guarded store proxies, the deferred `StorageBackend` swap and the mount table,
`register`/`unregister`, `complete`, the session runner, and the core tools (`gate_action`,
`single_turn`, `about_matbot`). Both apps call it. It was two hand-kept copies, and a step added to one
was simply absent from the other with nothing to fail.

A host passes only what is genuinely its own: its carriers (installed first), its boot `StorageBackend`
(the CLI's filesystem one, the browser's IndexedDB + OPFS), its boot `Vault`, how a secret is resolved
(the browser prompts for a missing one), and the
members that acquire a plugin (`loadPlugin`, `unloadPlugin`, `resolver`). `preScanStorage` opens a
configured storage plugin's backend before any store exists, and `loaded()` runs the post-load checks.

**One machine per process at a time, and a second `assembleMachine` throws.** Core's plugin registry and
settings defaults are the module's, and a plugin is one module instance whatever machine loads it, holding
what it captured from the machine that set it up — so a second machine would half-share the first, with
nothing to say so. Isolation is a process (`background-jobs-node`); several principals are one machine.
`dispose()` frees the slot, which is what lets a test file build a machine per test.

### Package naming
- `@matatbread/matbot-foo` — single implementation
- `@matatbread/matbot-foo-types` — interface-only (augments `MatbotServices`)
- `@matatbread/matbot-foo-node` / `-browser` — platform-specific

**`matbotRuntime` is the plugin marker.** A package under `plugins/` is a plugin if and only if its
`package.json` declares the runtimes it supports. The loader refuses an undeclared package before importing
it, and discovery passes over one unimported, so a library that lives beside the plugins
(a shared helper of your own) omits the field and is never mistaken for one —
nothing has to run its top-level code to find out. core, plugin-api and the apps do not declare it either.

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

**Aliases name a role, not a configuration.** An entry may be `alias: <profile>` and nothing else
(`ProviderAlias`): a stable name by *function* (`text_classifier`) that code, a pinned setting or a
stored function can hard-code, because the alternative is hard-coding a profile and breaking when it is
renamed or replaced. A `tool_function` run outside any turn has no provider to inherit and no settings of
its own, so a name is the only thing it can hold. It is not the reference the rule above rejects: an
alias carries no fields, so there is nothing to inherit or merge — `parameters` beside `alias:` is
refused (`aliasProblem`, so by the registry whoever writes, and at parse), `add` and `update` refuse an
alias's name, and a per-call override is `req.parameters`.

- **One hop.** The target is a profile, never an alias, so a cycle cannot be written and resolving is one
  lookup. Every writer asks `aliasProblem`; the registry enforces it (`register` and `remove` throw).
  `revert` does not, since a plugin's unload must complete, so an alias can still be left without its
  target; `resolve` then fails the call naming it.
- **Resolved at the bottom, persisted as chosen.** `providers.resolve` is called where a provider is
  called — `complete()` and the session runner's per-turn `resolveProvider` — and nowhere above. A
  message's `providerName`, a turn's `RunConfig.provider`, `ToolContext.provider` and every pinned setting
  keep the name that was chosen, so they follow the alias when it moves. What is a fact about the CALL
  records the profile: a usage entry (rates are the model's), and the config an adapter is handed.
- **An adapter that trusts round-trip state by provider identity records the model** in its own
  `ProviderMeta` slice, because `providerName` no longer says which model produced a message: an alias
  keeps its name while its profile changes. Google's thought signatures do (`meta.google.model`, on tool
  calls and thinking blocks), falling back to the profile name for history written before.
- **Listed as their profile, marked.** `provider list` reports an alias as its profile's row under the
  alias's own name, with `alias` naming the profile (`providerRows`). One shape, so code reading a field
  off a row needs no narrowing and every callable name is in one list; the fields are information, and
  `alias` says what the row is. A picker offering what a person runs on skips those rows. A list a MODEL
  reads (an unknown-provider error) shows them as `alias → profile` (`describeProviders`), so it learns
  the role names exist.
- **No plugin defaults to a well-known alias name.** That is the `skills-classifier` pattern triggers
  retired in 0.5.0: a magic name that changed behaviour by existing. An alias works only where a call
  site names it.

**Provider round-trip metadata (`ProviderMeta`).** Some providers require an opaque token to be echoed back verbatim when a tool-call is replayed in history — e.g. Gemini 3 "thought signatures", mandatory on every historical `functionCall` or the request 400s. This rides on a tool-call's `meta?: ProviderMeta` (on both `CompletionEvent` and `MessageContent`). `ProviderMeta` is an empty, **augmentable** interface (same idiom as `MatbotServices`/`MarkerData`): a provider package declares its own namespaced slice from its own module (`interface ProviderMeta { google?: { thoughtSignature?: string } }`), so core carries `meta` opaquely — stores, renders, or elides it — and **never changes when a provider adds round-trip state**. It's interface augmentation, not a generic parameter, because one session interleaves tool-calls from many providers. An adapter replays a token only when the message that produced it came from the *current* provider (a foreign token is elided/degraded, never posted into a slot it doesn't belong in).

---

## Default plugin settings

`default_settings:` in `matbot.yaml` (`BrowserConfig.defaultSettings` in the browser) is a **read-only
floor** under `services.settings()`, keyed by plugin NAME — the settings namespace — and installed by
the host at boot with `installSettingsDefaults`. It exists so a project can ship an opinionated install
without a wrapper package per plugin: identity is loader-derived from the package name, so wrapping a
plugin to initialise it MOVES its settings namespace to the wrapper, orphaning what the install already
stored and colliding on every tool name if both load.

**One rule: reads are layered, writes are not.** `get` returns the stored key if present (`in`, so a
stored `null` is an override), else the install default, else `undefined` — which lands *above* a
plugin's own `?? codeDefault`, so config beats code with no plugin change. The CAS `update` path reads
the stored document only, so `set` persists exactly the key it was given. Seeding — at install or on
first write — was rejected: the first makes a later yaml edit silently dead, the second makes whether
an edit works depend on unrelated write history, and both write a per-principal document for what is
install-wide configuration. `delete` therefore means "revert to the configured default", which is what
every existing `clear` action already meant.

Merging is per **key**; a value is opaque (the only addressable unit `PluginSettings` has, and deep
merge has no bounded semantics). No `${NAME}` resolution — secrets are the Vault's, and resolving at
`get` time would give the settings facade a Vault dependency.

**The defaults are consulted INSIDE `makePluginSettings`, not passed to it.** A parameter is a thing a
call site forgets with no error and no symptom, and one already would: the web bundle builds its own
facade over a concrete backend (`apps/web-bundle/src/extra-plugins.ts`) to pin its plugin list across a
`StorageBackend` swap. Same reasoning as
the barrier living inside `machineBusy`.

**The one silent failure is a key naming no loaded plugin** (the name is loader-derived and need not
match the specifier in `plugins:`), so `assembleMachine`'s `loaded()` warns for unmatched keys once the loaded set is known;
reserved dunder namespaces are exempt, not being plugins. Nothing distinguishes a defaulted read from a
stored one — a `*_config get` action reports what is *in effect*, not what is pinned.

**Deliberately no tooling to author a default.** The write path for a runtime actor is the override,
which is CAS'd, per-principal and notifiable; authoring the floor is installation authoring, and a tool
for it would be a second way to do one thing, with restart semantics and no CAS. Which file holds it is
a host concern by construction — core takes a map, never a path — so a second location stays a ~10-line
host change. `extends:` is NOT that mechanism today: the CLI chdirs to the base's directory and takes
its own config path from there, so a shared base becomes the project (`.data`, `.env`, and every yaml write land there).

---

## Data layout

**A plugin never derives a directory; the host hands it two.** `projectDir` is where the host resolves
packages and relative plugin specifiers from — a plugin writing code for the host to load (a compiled
skill), typing against what is installed, or telling a user where to install a package uses it. `dataDir`
is where plugins keep state on disk — a storage backend's files, a sandbox's mount. Both are optional
`MatbotMachine` members, absent in a browser; a plugin that needs one degrades without it. Nothing is
derived from a config file's location, the working directory or a fixed name: that is a host's layout,
and what follows is the CLI's.

The CLI's: `projectDir` is the directory holding `matbot.yaml`, and `dataDir` is `.data/` beside it —
all runtime state, never in source:

```
.data/
  sessions/, settings/, skills/, triggers/, schedules/
  knowledge/, bash-cwd/, files/
```

`.data/` is gitignored. Plugins may add subdirectories. Other storage providers (e.g. SQLite) differ.
The CLI publishes the config it booted with as `MATBOT_CONFIG`, beside `IS_SUB_AGENT` and
`MATBOT_PRINCIPAL` — the command-line contract `background-jobs-node` starts a job with.

**`.plugins/`** (the CLI's) — fetched remote-module cache, **separate** from `.data/`. `.data/` is LLM read-write runtime state; `.plugins/` is matbot-writes / LLM-reads-only (mounted read-only into docker-bash). Never relocate it. Gitignored. It holds remote *plugins* — and only those: a `tool_function` body cannot import a URL (see *Module access from a `tool_function`*). One cache, because a second fetch-and-materialise directory is the thing that drifts — and the contract is unchanged either way: matbot writes it, the model only reads it. A dot-directory in there is matbot's own bookkeeping rather than a mirrored host (`.restore` holds the copy a refresh set aside, so a failed reload can put the working one back; `.urls` holds what plugins import by URL, below; `.installs` records what `plugin add` changed in the project, so `remove` takes back only that), which is why the cache scan skips them.

**Two identities in it, by what the thing is.** A plugin's own files are *mirrored*, `.plugins/<host>/<path…>`, and load as `file:` — a package was a file tree before it was served, so the mirror loses nothing, and it is what lets a dependency `plugin add` installs beside it resolve and a Node-only plugin read its files through `import.meta.url`. A module a plugin imports by absolute URL keeps that URL as its identity, as it does in the browser, and is stored by hash under `.urls`. A CDN's URL space is not a file tree — one path is a module and the parent of others, a response redirects, the query is part of the name — and mirroring it turned each of those into a special case of the path mapping (the `ENOTDIR` of issue #89 was the first). Do not route URL imports back into the mirror to make them browsable; a hash is the point.

---

## Open-registry augmentation

**Six extension points, one technique** — the most distinctive thing about matbot's API, and previously explained five times in five places. Each is an empty (or near-empty) interface in `plugin-api` that a package adds a key to via `declare module`; declaration merging accumulates every loaded plugin's contribution, so `plugin-api` never changes and never learns that the package exists. Helper types derive the real shapes from the merged registry.

| Registry | Key | Value | Home |
|---|---|---|---|
| `MatbotServices` | interface name | `Foo?: Foo` | `plugin.ts` |
| `ToolContracts` | tool name | `ToolContract<Result, Params>` arms | `types/tools.ts` |
| `Notifications` | `<package-name>#<InterfaceName>` | the notification shape | `notify.ts` |
| `MarkerData` | marker creator | the `data` shape | `types/messages.ts` |
| `ProviderMeta` | the package's namespace | its round-trip state | `types/provider.ts` |
| `SessionTypes` | tool name | what the session being checked holds, for that tool | `types/tools.ts` |

`SessionTypes` is the one a package does not augment itself: its tool's `sessionType(session)` answers, and
the checker augments it under that tool's name for one check made on a session's behalf (`function-tools`'
`sessionContext`), so a tool fills its own key and no other. Otherwise it is the same technique, and a check
made for no session sees it empty — the "absence is a type" consequence below.

Four consequences follow from the technique, and account for most of the per-registry rules stated elsewhere in this document:

1. **The key is the type's identity** — there is no runtime type information at these boundaries, so the string *is* the erasure-time stand-in. Name it after the thing, never a role. `Notifications` qualifies with a package name because a `kind` is globally scoped and an importer cannot rename it out of a collision.
2. **Open at runtime** — a plugin this build never compiled against, or a bridged remote, can contribute a key. Always `default` a `switch`; exhaustiveness checking over these is unsound.
3. **Absence is a type** — `?:` is the whole mechanism by which "may not be loaded" reaches a call site. Degrade; never fall back to loading it (*Discovery vs. direct dependency*).
4. **Unregistered ⇒ loose, not broken** — an unknown tool name yields `unknown`, an unregistered marker creator `data: unknown`. Base types stay permissive so the unions still work.

The author-facing version is `docs/DEVELOPING.md` *Open-registry augmentation*; each of the six declarations points at it rather than restating it.

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

**Swappable core members** (`StorageBackend`, `KnowledgeIndex`, `Vault`, `Notifier`; `PermissionGate` and `MediaStore` revert the same way but are read per access rather than through a proxy — see *Permission gates* and *Media*) use `register` to swap live impls behind capture-safe forwarding proxies. A captured reference keeps resolving to the current impl. On `unregister` (i.e. when the providing plugin is unloaded) a swap-member **reverts to the host's captured boot default** rather than dangling on the gone impl — the app decides its own base services (the CLI: the filesystem backend; the browser: IndexedDB + OPFS), and the registry only remembers and restores them. The host's boot default is captured **before** any storage-plugin pre-scan, so a config-supplied backend never poses as the base; a pre-scanned backend is recorded as plugin-owned, so unloading its plugin reverts to that base.

**A plugin's unload withdraws its own registration, not the key.** The registry holds one value per key, but core remembers each plugin's registration in order, for every key. Withdrawing the current one reinstates the one it displaced; withdrawing a displaced one changes nothing; only the last one out reverts to the host (above). It was `unregister(key)`, which removed whatever was current, so where plugins stack by capturing what they displace (`ts-validation` over `json-validation`, a gate over a gate), unloading the one underneath took the one on top with it. `StorageBackend` is the exception on one side only: a displaced backend was closed by the swap, so withdrawing the live one reverts to the host's — but withdrawing a displaced one still leaves the live one alone.

**A reference captured from the registry is hard.** Unloading its provider changes what the registry resolves, not what a plugin already holds, so an object that outlives its plugin is that provider's to answer for — by failing with "service no longer active", not by working on half-torn-down state. Resolution through the registry is dynamic, so the removal of a dependency can only be relied on dynamically; nothing static can see it coming. A dependency that must hold is a real `package.json` import, which loads and unloads the two as a unit (*Discovery vs. direct dependency*).

### Context switch & the deferred StorageBackend swap

`StorageBackend` is the system of record: swapping it under a running turn would split a compare-and-swap across two backends. So `register('StorageBackend', …)` (and its `unregister` revert) is **deferred**, not immediate — it stages a last-write-wins pending slot and applies it at the next **quiescent edge** (nothing holding the machine — in practice, the pump's queue drained). The other swap-members (`KnowledgeIndex`, `Vault`) repoint immediately.

A **context switch** is the machine analogue of an OS one — "page in pending machine state, then set the owner." Two primitives, one per half: `runAs(principal, fn)` sets the owner (the principal carrier stays a pure identity primitive), and `machineBusy(fn)` holds the machine, running host-registered flushers (`onContextQuiesce`) at the release edge. `contextSwitch(principal, fn)` is simply both, for an operation that is both. The hold is a *wrapper*, never a `begin`/`end` pair: it releases on every exit including a throw, and a stranded counter is unrecoverable — every later flush would no-op forever, with no symptom but a deferred mutation that never happens.

**Scheduling edge work is one call.** `onContextQuiesce` registers *and announces*, so the barrier engages and the edge is guaranteed to arrive — a one-shot is `onContextQuiesce(un => { un(); work() })` (the closure holds the work; no pending flag), and a standing flusher is the same without the `un()`, which then MUST be idempotent since it runs at every edge. Repeated announcements that should collapse into **one** apply — the host's staged `StorageBackend` swap, a dirty mount key — use `scheduleAtEdge(work)`, a guarded one-shot: the guard coalesces the stagings and the work reads a last-write-wins slot, so three registers before an edge install one backend rather than three in turn. Continuous delivery is a *standing registration*, never a callback re-registering itself — registering means "I have work now", so a self-re-registering callback would announce fresh work from inside the sweep answering the last lot and re-enter forever; there is no independent clock to wait for. `onContextQuiesce` is a *subscription* (ask twice, run twice — each call carries its own work); `scheduleAtEdge` is a *dirty flag* (poke it N times, run once, reading a slot at fire time). `flushIfQuiescent` is private: announcing is what registering does, so exposing "force an edge" only offered callers a way to reason about firing that they should not need. Registering also schedules its own edge attempt on a microtask, never inline: a callback must not run before the statement registering it has returned.

**A flusher may suspend the edge.** `onContextQuiesce` takes `(un) => void | Promise<void>`; returning a promise makes the edge *wait*. Flushers are invoked in registration order and then settle together; the synchronous prefix runs inline, so synchronous work registered on an idle machine is in effect by the time the sweep returns. Serialising flushers against *each other* is deliberately not done — it would remove one source of concurrent mutation and leave every other, at the price of every flusher waiting on the slowest.

**The edge is a barrier, not a counter — for liveness, not for coherence.** `machineBusy` waits for staged work to land before taking the hold, so a flusher runs with the machine to itself for its whole extent (an entrant can no longer walk in through a flusher's `await`). The reason is *not* CAS coherence: that belongs to `mediumGuard`, which fails a write whose read came from another backend on the version stamp, and to the `Store`'s own CAS — contention over a service is the service's to resolve. It is that **a counter cannot force `depth` to reach zero**. Under continuously overlapping holds — several sessions on a busy server, each pump holding across its own queue — the edge never arrives, and a staged swap that never applies and a remount that is never announced are both failures with no symptom. Barring entry is the only way to make the drain reachable.

The wait lives *inside* `machineBusy` rather than at the call site, for the reason `runAs` is ambient and a mount interest is bound to its plugin's load extent: spelled outside, a second caller who omits it gets no error and no symptom, just work that stops landing. It is **bounded** (one constant, then it proceeds with a warning), because a counter cannot distinguish a nested entrant from a concurrent one — an LLM reaching a matbot HTTP endpoint through its own `http`/`bash` tool is inside its own turn's hold, and would otherwise wait on a drain that includes itself. Telling the two apart needs a hold-identity carrier and the platform split that implies; the bound degrades to the pre-barrier behaviour instead of hanging. `quiesced()` remains for an operation that needs deferred work complete without holding the machine; the pump no longer calls it.

**What holds the machine is the operation, not the turn.** The pump holds it across its **whole queue** and `runAs`es per item, because the pump's own store work does not stop at a turn's end: it reads the committed document back for `followup`, appends markers to it, rewrites it for a retract, and persists the next turn's user message before that turn opens. A per-turn hold declared all of that idle — six edges fell inside one two-turn queue — so a mutation could land in precisely the gap the deferral exists to close. The queue draining is the real boundary, and it is the one accounting already flushes at, for the same stated reason: "the end of a turn" is not a moment anything can be totalled or swapped at. Entry points that *receive* work without performing it — a web request holding an SSE stream open, a telegram message — stay `runAs` and are deliberately not busy; counting them would mean the machine never reaches an edge at all.

### Session writes (`SessionRunner.write`)

A turn works on an in-memory copy of its session and writes it back whole when it ends, so a write landing mid-turn is silently undone. Session writes used to wait for the machine edge, which waits for **every** turn on the machine rather than the one holding that session: a rename raised a machine-wide barrier, a long parallel turn or an in-process job held back every session's writes, and the admit bound fired for work that was never machine-wide. A session write is not machine work. **The runner is each session's one writer**: `SessionRunner.write(sessionId, attempt, lost)` runs `attempt` between that session's turns (`drainWrites`, at the top of the pump's loop, before the next turn reads), in arrival order, and no turn of the session starts until it is done. Other sessions' turns do not delay it. With no turn to wait for it runs at once — as the pump, so a submission arriving meanwhile queues behind it instead of reading under it.

**"Nothing is written mid-turn" is not the invariant; "the runner owns the session exclusively" is.**
Several writes during one turn are fine as long as the runner knows about all of them, and one case needs
it: a parallel turn's write-back is a *completed* turn, not a partial one, so it is placed in the store as it
settles (`placeNow`) rather than waiting for the running turn's next round boundary — which a turn parked
in one long tool call never reaches, leaving a finished reply in no store, no replay and no stream. The
span goes on `merges` as well, so the running turn takes it into its own in-memory session and its
whole-document write-back carries it instead of erasing it; `end` does a final `interject` pull, being the
funnel every exit passes through, for the turn that is aborted inside that same tool call and so reaches
no further boundary. The three placement paths — `placeNow`, `interjectInto`, `drainMerges` — are mutually
idempotent on its head's message id, and exactly one announces `merged`. The turn's own partial output is
a different thing and stays unpersisted: it is genuinely incomplete, and a crash must not commit half a
turn.

**What crosses back is the turn's whole settled span**, not its final text: the submission (with the
framing block subtracted, but any `durable` fold a `contextual` trigger made KEPT), then every message the
turn produced — thinking, tool calls, their results, its markers, a retraction and the redo that
superseded it, a `followup` resubmit's robo turn. The session is the only record once the live stream is
gone, and one holding the answer alone makes a tool call a parallel turn genuinely made unrecoverable:
`determine_provenance` finds no invocation and reads a truthful report as fabricated. It is read after the
nested runner idles, so it is what that turn's own hooks settled on rather than its first draft, and it is
trimmed to the last point at which every tool-call has its result (`closedSpan`) — an unpaired call placed
into shared history is not valid wire for any provider and would break every later turn. Thinking rides
along persisted but unsubmitted (every adapter elides a historical block) and a foreign round-trip token
is the adapters' to drop by `providerName`, so none of this depends on which provider ran the turn.

**A span is anchored on the head its OWN copy was cut at**, captured at submit and carried on the reply —
never on the session's current head. The two differ exactly where it matters: a parallel turn submitted
*during* a turn's `followup` ran on a copy that INCLUDED that finished turn, so its span belongs after it,
and the current head would put it in front of the very history it answered. A reply with no head of its
own belongs at the tail, which is the pump's to append and must wait for it — appended early it would
become the session's last user message, which is the turn a redo re-runs.

**The corollary is that post-commit writes compare.** `followup`'s marker append and its retract rewrite
were whole-document `set`s built from the session the hooks were handed before they ran, justified by the
pump being the only writer once a turn has committed. It no longer is, so both CAS against that snapshot
and rebuild from `current` if it moved, and the retraction enqueues its redo only if the write landed.
Rebuilding is safe because every landmark they use is "the last user message", which a pair placed ahead
of it does not move. They CAS rather than re-read because a re-read costs a round trip per turn and
consumes the next `store.get`, which is a thing a test legitimately holds.

**Ordering, not a lock — and CAS stays.** Nothing is held but the runner's own per-session state, the same map `status()` reads; there is no lock object, and nothing in `Session` or `Store`, which do not lock and must not (OPFS, IndexedDB, Drive). `attempt` still reads the document and compare-and-swaps it, and a lost CAS is read again (bounded). Within a process, writes of one session no longer race each other; the CAS still answers a writer outside the runner — another process on the same store, a swap `mediumGuard` refuses. Across processes this does nothing, any more than the edge did: a background job's process forwards over its channel instead.

**`deferred` says who may wait.** It is true when a turn of the session is in progress (or a redo is next), so the write waits for that turn — which may be the caller's own, so awaiting `done` then deadlocks. Callers say "queued" when deferred and report the real outcome otherwise. `done` never rejects; a write logs its own failures. The write never starts before `write()` returns, so an attempt may read what its caller set from `deferred`. At a boundary, writes go before parallel replies (a cut queued by the turn just ended drops through to the end, and would take a reply appended before it), and neither goes ahead of a redo.

The machine edge keeps what is machine-wide: the `StorageBackend` swap and the mount table. A write runs inside the pump's hold, so a staged swap never lands under one.

### The mount table (`services.mounted`)

A plugin reacts to a registry service (re)mounting or being unloaded through **`services.mounted`** — a `Mounted` whose one method, `observe({ key, replay?, signal?, onUnmount? }, handler)`, is keyed on the service it cares about. The host batches mount notifications to the **quiescent edge**: `register`/`unregister` mark a key dirty; the edge computes each key's net presence transition and **multicasts** to that key's subscribers. A reload (unregister+register before the edge) collapses to a single **remount**; an unregister not replaced by the edge is a **committed unload**, delivered to `onUnmount`. The contract guarantees only *eventual, ordered* delivery per key — **it says nothing about timing** (a register is not observably inline, nor pinned to a turn boundary). `StorageBackend`'s swap also lands at the edge (CAS coherence); other keys repoint immediately but still notify at the edge.

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

**`runAs` covers deferred work, because the natural thing to write returns it.** A generator's body does not
begin until the first pull, so an iterator returned out of the scope carried its whole extent outside it —
and the tool ABI (`executor.execute()`) returns exactly that shape, which made a host wiring its own tool
invocation reach for the broken form first. Worse than a throw: a host that entered a boot principal read a
*plausible* one, so nothing looked wrong. So `runAs` re-establishes the identity around each pull of a
returned async iterator, and unwraps a native promise to find one behind an `async () => execute(…)`. The
value stays what it was — the wrapper is a Proxy over the four pull points, so a class-based iterator keeps
its own members, its prototype and `instanceof`; an exotic thenable is left entirely alone, since
`PromiseLike.then` need not return a promise and adopting one would hand back a different object. Two
things are deliberately *not* rescoped: the caller's own continuations (a `catch`/`finally` chained onto the
result runs in the caller's flow — the alternative extends a privilege rather than dropping one), and an
iterator nested inside a returned object (`{ events }`), which no structural check can reach.

**Nesting is not a new rule, and a returned *function* is not bound.** `runAs(A, () => runAs(B, () => gen()))`
stacks two wrappers and every pull resolves to B — the same answer plain nesting gives with no iterator in
sight, at one extra carrier entry per layer per pull. A returned function is deliberately left alone, because
the asymmetry that put the iterator wrap *inside* `runAs` does not hold for it: an iterator has exactly one
thing that can be done to it, and pulling it IS the deferred half of the operation the scope was opened for,
which the caller cannot spell from outside. A function is a *new* operation the caller starts later, N times,
and the spelling is theirs and obvious — scope the call, not the construction (`() => runAs(p, () => fn(x))`).
Binding one would pin an identity onto every future invocation, including the ones meant to run as someone
else: privilege extension, the same thing rejected for a patched thenable's continuations. And nothing
distinguishes a deferred body from a factory result — `typeof value === 'function'` is equally true of a
class (a naive wrap breaks `new`), an unsubscribe function, and a comparator, where the iterator test names a
specific ABI shape. If a host seam ever genuinely wants it, that is an explicit `bindPrincipal(p, fn)` the
author opts into, because there the identity is a *decision* rather than a repair.

**It does not generalise to the machine hold or the usage scope.** `machineBusy` and `withUsageScope` have
the identical `() => T` shape and the identical footgun, and must keep the documented warning instead: an
identity is a re-entrant label, whereas a hold and a roll-up settle when `fn` does. Re-acquiring the hold per
pull is not holding across the stream (and would re-enter the admit barrier every yield), and a usage scope
rolls up on settle, so a later pull's entries would land after the roll-up. `contextSwitch(p, () => gen())`
therefore gets the right identity and still releases the hold early.

**Platform split:** node uses `AsyncLocalStorage`-backed carrier (in `host-node`); browser/single-principal uses constant carrier (in plugin-api).

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
| `screen`     | once per turn, before 1st provider call | read-write | replace `session`, add `ephemeral` context (tail of outgoing messages, never persisted), add `durable` context (folded onto the user turn — persisted + visible — and carried live as `robo-user`), append durable `markers`, offer turn-scoped `tools`, and/or `abort` |
| `contribute` | before *every* provider call | read-only | return transformed `outgoing` copy (ephemeral) |
| `toolcall`   | before each tool exec | read-only | `rejectTool` and/or `abort` |
| `toolresult` | after each tool exec | read-only | replace `result` (redaction) or observe |
| `followup`   | once, post-commit | read + durable-marker | `resubmit` robo turn, `retractAndRerun` (pop committed turn, re-run with context), append durable `markers` |
| `validate`   | before each tool exec, **at the executor** (every door, not only the runner) | none | return `ToolInputError[]` to refuse, `[]` for valid, nothing for no opinion — see *Tool-call validation* |

`screen` and `followup` are the durable-mutate points (once per turn). `contribute` is the in-harness cousin of a wrapping provider — mind prompt caching: inject at the tail or as stable prefix.

### Turn-scoped tools

`screen`'s `tools` is a **source**, `(session) => Tool[]`, that the runner asks at the top of every round — not a list — because a turn's own tool calls change the session it derives from, and a tool defined in round 2 must be callable in round 3. Its tools are never registered: advertised *after* the `ToolPresenter` (whose search reads the registry, so a tool it windowed out could never come back), resolved *after* the registry, and carried to nested calls on `ToolContext.turnTools`, which `invokeTool` consults — so `tool.x()` inside a composed function reaches them exactly as the model does, and a sessionless door (`POST /tools/:name`) cannot. A name the registry holds is dropped: shadowing a registered tool is a gated decision (`tools.overwrite`) and a hook is not a way round it. A `validate` hook is dispatched by the registry's executor wrapper, which these never get, so it has nothing to say about them; a source validates its own tools' input.

The one consumer is `function-tools`' `define { scope: 'session' }`, which stores each definition as a marker in its session (so fork/cut/compact carry it) and types `tool.<session fn>()` by appending a `ToolContracts` augmentation **after** the snippet it checks — built from `turnTools`, never from the markers, so what passes the check is exactly what resolves at run time.

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

The user-surface kinds were one kind named `augment` (= today's `ephemeral`); a stored trigger still carrying it is migrated to `ephemeral` when it is read, with a warning — on read rather than at load, because the store is read per principal (removed in 0.6.0).

**Observational dispatch:** tool's output is the signal. A `result` → inject; no result → silent side-effect. The dispatcher is a dumb transport — tools frame themselves.

**Fails soft.** Absent tool → nothing happens. Conditions evaluated by a classifier provider (Settings-resolved, falls back to turn's provider). Zero config required.

**The classifier lists its matches only, and the conditions are its stable prefix.** The conditions go in the classifier's *system* prompt, stable while the trigger set is, and the exchange is the prompt. Every provider's prompt cache is a prefix cache and every adapter sends the system prompt first, so this needs nothing provider-specific: with the exchange ahead of the conditions, only the rubric was reusable. The reply is `{ "matched": [{ "id", "why" }] }`. Output tokens are what take the time — a verdict per condition cost ~6,500 for 125 conditions, two minutes — and the reply is a list rather than a map from id to evidence because in a map every value is a string, so a non-match written out anyway would fire. The reply is read for its **last** verdict, by a string-aware scan for complete objects rather than one greedy brace match: a classifier that writes a verdict, second-guesses it and writes another left prose between two objects, which no single match can parse, and the turn fired nothing.

**The user surface races its verdict by default.** `screen` kicks the classifier off and returns; a verdict races generation (an in-situ restart if it lands before commit, else a retract-redo from `followup`), so a turn with no match — nearly every turn — waits for nothing. `classifierGraceMs` holds the first token for up to that long, so a match informs the answer; an installation with frequent matches and a fast classifier sets it.

**`TriggerFilter` withholds triggers from one conversation.** An optional `MatbotServices` member registered by whichever plugin holds the policy — never by triggers, which reads it at every evaluation (the `ToolPresenter` shape), so load order is irrelevant and unloading the policy's plugin withdraws it. `admit(triggers, { session, surface })` is offered the enabled triggers on that surface and returns those that may be judged; a withheld trigger never reaches the classifier, so it cannot fire. The answer is intersected with the offer, in stored order (no invented triggers, no cache churn). A throwing filter is skipped with a warning and everything is judged. triggers knows nothing of *why* a filter withholds. The context is an object so it can gain fields without changing `admit`.

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

That string is also **typed**, for validation (below): the emitter needs a `ts.Type` and a string is not one, so the live set of them is rendered into a virtual augmentation file and resolved by a small second `ts.Program` — that file plus `plugin-api`, never a second workspace scan. It is a second Program because the `import type` list must be **exact**, and that is only knowable from plugin-api's resolved exports, i.e. from the first Program's checker; the cheaper trick of rewriting every capitalised bare name to an inline `import(...)` needs a denylist of TypeScript's own utility types, and the first thing it breaks is `Record<string, never>` — which is `NoParams`, the commonest synthetic params type there is. Each string is screened alone before the batch is rendered (they become properties of one interface, where a stray brace swallows every arm after it), and the file must then typecheck **cleanly**: an unresolved reference is `any`, which validates everything, so any diagnostic in it becomes a stated refusal for that tool rather than a validator that reports success and checks nothing. The dts arm and wire text stay spliced verbatim from the string — that is what the model already reads, and re-deriving them from the resolved type would expand an alias the author wrote deliberately.

A string may name types that exist nowhere else — a function package's own `interface HubReport` — and
then carries their declarations on **`toolContractTypes`**. Every consumer (the dts, the validator's
Program, a turn's own tools appended to a snippet, the browser's index) writes the pair out with one
helper, `contractArms` in plugin-api: the declarations go in a namespace of their own with an alias per
tool beside them, so the contract stays exactly as written and still resolves, and two packages' types of
one name never merge. A diagnostic inside such a namespace refuses the tools it serves and no others.

**A result shaped by the call's own params takes a third slot, `Call`.** `ToolContract<Result, Args, Call>`
carries the exact generic signature `ToolProxy` declares, because a fixed `Result` cannot say "in each
position, what that turn could return" (`single_turn`'s `turns`). `Result` and `Args` stay the whole contract everywhere else (the executor,
the wire text, validation), so they must describe every call the signature admits, and a model calling the
tool directly sees the plain form. Only a source-declared contract can use it: a `toolContract` string is
still exactly two arguments.

**A defined function's `inputSchema` is the checker's on node, and the text's in the browser.** The browser
has no compiler, so `function-tools` derives a schema from the parameter text by hand, and that cannot see
a named or imported type, an alias or `Omit<…>`: each degrades to `{}`, which tells a provider nothing and
lets `json-validation` accept anything. On node the define's own check also reports each parameter's schema
from its RESOLVED type (`check(snippet, { parametersOf })`, emitted by `tool-types/src/parameters.cts` in
the checker's worker), with the text path's conventions so the two agree where both can answer. It is
STORED with the definition (a function's record, a session marker, a package's per-export map), because
nothing re-checks a definition on load; absent — the browser, `noTypeCheck`, a record from before 0.5.0 —
the text path answers as it always did.

There are **no** `paramsType`/`resultType` fields — they are fully retired. A foreign tool (e.g. an MCP proxy) that carries neither an augmentation nor a `toolContract` falls back to its loose `inputSchema`, and the registry block emits `ToolContract<unknown, unknown>` so it stays in `keyof ToolContracts` (hence callable, loosely, through `ToolProxy`). Unregistered ⇒ `unknown`.

**A scanned root supplies a tool's *contract*; only the live registry says the tool *exists*.** The dts scan roots at `plugin-api`, at `core` (for the tools `assembleMachine` registers itself, which no plugin owns: `about_matbot`, `single_turn`, `gate_action` — `plugin`/`provider` are declared in `plugin-api` beside their shapes for the same reason) and at each loaded plugin's `resolvedUrl`, and then UNIONs a glob of the monorepo `plugins/` tree onto it — not a fallback, but the only view a static caller with no loaded set has (the web bundle's build) — so the roots are a **superset** of the loaded set by construction, reaching plugins for other runtimes and plugins nobody loaded. `buildMatbotToolsDts` therefore emits only the keys in `tools.list()`. A declared-but-unloaded tool is worse than an absent one: `await tool.telegram_send({ text })` typechecks clean against it and throws `not registered` at runtime — the one failure the check gate exists to prevent, and one the repair loop cannot repair, because the code is correct against the types it was shown. Contrast `MatbotServices`, which takes no such filter: absence there is already a type (the `?:` *is* the "may not be loaded" signal), whereas a `ToolContracts` key carries no such qualifier — declared means callable. What the filter cannot settle is two roots declaring one *live* name (`bash`, by `plugins/bash` and `plugins/docker-bash`): that still merges by Program file order, and is reported via `conflicts` rather than resolved.

### Tool-call validation

The contract above is also **enforced**, by `validate` hooks that core dispatches **at the executor** — wrapped once per tool at *registration*, so there is one wrapper per tool and `resolve(x) === resolve(x)` still holds. `tools.validate(name, params)` asks the same hooks without running the tool, for a caller storing a call to make later (a trigger's `invoke`). With none registered, nothing is checked: core **mandates** no validation, it only honours what is registered.

**Dispatched at the executor, not by the runner.** `toolcall` still exists and is still the place to reject a call by *policy*, but it is a **runner** channel, so a validator installed there guards the model's path and nothing else — `POST /tools/:name` and `invokeTool` call `tool.executor.execute` directly and fire no runner hooks at all. The executor is the one place every door already passes through: one check rather than one per door, and nothing to drift. That is why `validate` carries no session. The accepted cost is that an *internal* call is validated too, though a statically-typed call site should already be sound — not pure waste, since `invokeTool` with a dynamic name, a trigger's `invoke.params` (typed `object`) and a compiled skill's payload are all internal callers no compiler has checked.

**`undefined` means NO OPINION, never "valid"** — no contract for this tool, or one that cannot be honestly validated (a throw counts the same, logged). **Every** `validate` hook is asked, and the call is refused if **any** refuses it, with each refusal's errors reported (one two validators share is said once). So validators co-exist with no reference to one another, neither the verdict nor the message depends on load order, and unloading one removes its opinion and nothing else. This was a single-valued `ToolCallValidator` service, which forced the second validator to capture the first and delegate to it: the pair depended on load order and on each other, and unloading the one underneath took the other with it. It was removed in 0.5.0. Two suppliers exist: `ts-validation` (the `ToolContract` params *type*, via `tool-types`, node-only) and `json-validation` (the `inputSchema` projection, cross-runtime, and therefore the browser's only option).

**Fail-open is worse than absent, everywhere in this path.** A validator that accepts everything while reporting success is indistinguishable from one that works, so an unvalidatable contract is a *stated refusal* that defers to the schema, and a diagnostic in generated type text condemns that tool rather than being ignored. The mirror of that rule is that failing **closed** is not the safe default it appears to be: `ts-validation` used to reject every call it could not verify, which bricked a live machine the moment `tool-types` was unloaded — every tool failed, including the `plugin` tool needed to put it back and the calls the web UI makes to draw itself, leaving a restart as the only way out. A dependency a plugin can simply re-create was never an unverifiable call.

**An unknown property is rejected**, as TypeScript rejects one on a fresh object literal — which is exactly what a model-authored params object is. Dropping it silently is the commonest tool-call hallucination made invisible: `sessionId` mis-sent as `session_id` reads to the tool as "no session given" rather than as a typo. `enforce: 'warn'` exists for the rollout, not as a resting state.

**The error is written for whoever has to fix the call.** Paths are dotted as the access would be written (`.items[0].name`, not JSON Pointer), and the offending value is shown wrapped in its own field name so it is a fragment the caller can compare against what it sent. A missing property shows no value (JSON carries no `undefined`); the rendering is capped, so a rejected attachment cannot turn one bad field into the bulk of a turn's context; and it cannot throw, since an internal caller may arrive with a `bigint` or a cycle and a throw while *reporting* an error would replace the diagnosis with a stack trace. The `error` event carries `TOOL_INPUT_INVALID` (422 — the body parsed, its *shape* is wrong), which a transport may map onto its own status; the number is safe in that field only because a process exit code cannot exceed 255.

---

## Permission gates

A privileged operation — installing a plugin, adding a provider profile, connecting an MCP server,
overwriting a tool another plugin owns — **declares** that acceptance is needed; a replaceable
service **decides** how it is obtained. One boolean question, one answer:

```ts
await ctx.gate({ gate: 'add', subject: specifier, label: 'Install plugin **"…"**?', fallback: false });
// → services.PermissionGate.decide({ gate: 'plugin.add', … }, ask, { session })
```

The call site used to do both jobs, and the *how* had already grown past a prompt: core held a
settings key, a memo, a per-tool allowlist and two "always" options for tool collisions, and three
copies of `confirmAction` implemented "ask a human, yes/no, default no". The consequence was the
thing fixed: an alternative installation could not *supply* a policy, only defeat one.

**The call site's whole contribution is `PermissionRequest`.** `gate` is a small, documented
vocabulary (`tools.overwrite`, `plugin.add`, `mcp_action.remove`); `subject` is what is acted on;
`label` is the prose naming the act, which a gate renders and never rewrites; `fallback` is what this
site does when nothing can be asked and nothing decides — today's non-interactive behaviour, stated
once per site instead of implied at each.

**`ask === undefined` IS "no human is reachable."** `decide` takes the channel in scope for that call
(the turn's `PromptFn`, or core's registration-path one) rather than holding one, because it is
per-turn and frontend-owned. The runner passes the RAW `opts.prompt`, never the stand-in that answers
with a field's default — that substitute would make "nobody is here" indistinguishable from "a human
answered with the default". `ToolContext.prompt` keeps the stand-in exactly as before.

**Where the act is made is the host's to state, beside the request (`PermissionContext`).** Today that
is the session, which a *for this session* answer is held against. It is a third argument rather than a
request field because the request is the tool's to write, and a tool that could name its session could
borrow another session's answers; `bindGate` takes it, required, from the door — the runner's turn, an
`invokeTool` caller's `opts.session` — since a door that omitted it would silently never be offered a
session lifetime, with nothing failing. A registration (`tools.overwrite`) has none. The HTTP tool door
has no session of its own, so it states a fixed sentinel, `HTTP_TOOL_SESSION` (`#http`), as its stub
session's id: something an installation can configure what that door may do unattended against, which a
fresh id per request was not. A `#` session is a door, not work anybody is doing, so no *session* answer
is offered there. The context is open: a later field (which door a call came in by) is how
*interactive* or *background* answers would become expressible, as more scopes to look an answer up in,
without another parameter.

**`ctx.gate` takes the SUFFIX; the host qualifies it with the tool's registered name.** So a plugin
cannot address a gate it does not own (tool-name collision on `register` closes the impersonation
route), and one policy covers both runtimes' implementations of a tool — the CLI's and the
browser's `plugin-tool` both register `plugin`; `mcp` and `mcp-http` both register `mcp_action`. The
host reserves `tools.*` for core's own gates.

A tool whose NAME is built at run time asks under a fixed `namespace` instead, on the request
(`ctx.gate({ namespace: 'tool_function', gate: 'import', … })`). A `function-tools` function's name is the
model's, and the default policy files standing answers by gate id: qualified by that name, each definition
would get its own id, so "allow ANY function to import node:fs", answered in one, would be stored where no
other function reads it. The host honours a namespace only when it names a tool registered by the **same
plugin** as the caller — both `pluginName`s being host stamps (`register`, and for a turn tool the `screen`
hook that offered it, whatever the tool claims) — so it widens nothing: a plugin still addresses only its
own gates. It was a `Tool.gateNamespace` field first, which needed explaining to every reader of `Tool`,
was relevant to one plugin, and let any tool claim any namespace including `tools`.

**`subject` is a field, never folded into `gate`.** A composite id makes the vocabulary unbounded,
which collides with "an unknown gate id must default to asking" — every newly-named tool would be an
unknown gate, and "ask about new overwrites, accept the ones already decided" would be unwritable,
there being no id meaning "overwrites in general". Subjects also contain the separator
(`@matatbread/matbot-foo`, `./plugins/x`, `https://…/plugin.ts`). And it is the identifier the call
site *has*, not a canonical identity: at `plugin.add` the plugin is not loaded, so the subject is the
specifier **as typed**, and a remembered allow for `@x/foo` will not match `https://…/foo.ts` —
correct (different trust root, different decision), but a policy author is keying on the spelling.

**`PermissionGate` is a swap-member, not an optional service.** Absence is not a sensible state, so
the host captures a boot default and `unregister` reverts to it — "unload the policy ⇒ back to
asking", with no revert rule of its own. (Back to the policy it displaced, if a plugin supplied one.) (A do-nothing always-present default *would* be the
fail-open shape; a default that *asks* is not.) A gate wanting "my rules, else the previous
behaviour" captures the gate it displaces and delegates, so a pair composes in either load order — and it is the reason this key is the one swap-member `assembleMachine` does
**not** put behind `forwardingProxy`. A capture-safe proxy resolves to whatever is current, so a gate
that captured `services.PermissionGate` and then registered itself would delegate *to itself*, for
ever; the hosts expose a getter instead, and every consumer resolves per call. Gate ids are open at
runtime, and an unknown one must **ask**: "unregistered ⇒ loose" cannot mean "⇒ allow" here.

**A synchronous caller gets a snapshot, not a second model.** `PermissionGate.snapshot(context)` (and
`ToolContext.gateSnapshot()`) is the policy's answer with nobody to ask, read once, asynchronously, and
then queried synchronously, for a call site that interposes on a synchronous API (`gate-fs-node` under
`readFileSync`), which blocks the very thread a prompt or a settings read needs. It is taken per
INVOCATION and never cached by the policy, for the reason `FunctionRunner.settings()` is read per
invocation: whose answers they are depends on how settings are partitioned. A caller that obtains an
answer through `decide` takes a fresh one. It was nearly a mirror of the settings namespace kept fresh off
the bus, and before that a `syncSettings` service: the first assumes a partitioning nobody promised, the
second exposes a synchronous read of every plugin's settings to fix one call site. The alternative to all
three, a per-module allow-list in the mediating plugin's own settings, was the thing being avoided: a
second permission model beside the gate, with its own format and nowhere `gate_action` could see it.

**Boolean only, one refusal shape.** Every gate in the system is allow-or-not, including
`tools.overwrite`, whose four options author the *memory*, not the outcome. This holds by
construction rather than by luck, because the value-returning prompts are excluded by construction:
`ask_user`, `store-key` secret entry and credential entry stay on `ctx.prompt` and are not routed —
not by an exemption list, but because they do not call a gate. Splitting authorization out of the
prompt channel is what deletes the routing rules a `gate?:` flag on `FormField` would have needed.
`allowed: false` is "not permitted" whether a human just said so or a stored answer did, so there is
nothing to branch on and no distinct denial error.

**The answer carries `source`, and it is for the REPORT, not the control flow.** A decision is
`{ allowed, source }`, where `source` names *which test in the cascade produced the answer* — not who
the actor was: `user` (a human was asked and answered, a no included), `session` (an answer held for
this session), `configuration` (a standing answer held everywhere or at a door), `fallback` (nothing
decided and nobody was reachable). It exists because a refusal
that says only `Cancelled.` reads to a model as a malfunction, so it goes looking for the malfunction:
it retries under another spelling, probes for a bug, or reaches for a route around the gate. Call sites
therefore render `refusalMessage(decision)`, which names the layer and — for the two sources nothing in
the turn can change — says there is nothing here to work around. `fallback` deliberately says the
opposite, because that one *can* change: a human present, or a standing answer.

The vocabulary is **open** (`PermissionSource` is `… | (string & {})`): a replacement policy has layers
of its own (`user-stored-preference`, an org directory, a rule table) and a closed union would mean a
policy could not report truthfully without a plugin-api change. So nothing switches on `source` for an
outcome, and a delegating gate passes the displaced gate's source back out unrewritten — rewriting it
would erase the one fact it carries. The default policy reports one `configuration` for both an
installation floor and a remembered answer, because settings reads are layered and nothing can tell the
two apart (see *Default plugin settings*); claiming `user` for a configured floor would be a lie half
the time.

The shape's one hazard is stated where it is read (`ToolContext.gate`): the decision is an object, so
`if (!await ctx.gate(…))` is always false. Test `.allowed`.

**The default policy is seeded, not a configured plugin** — it is core's (`core/src/default-gate`,
exported as `defaultGate`), and `assembleMachine` boots it as the `PermissionGate` and seeds `gate_action`
beside the other built-in tools unless the host passes a `gate` of its own. It has to be, because a *minimal* install's first act
is adding a plugin or a provider, which is gated: making the policy — or the means to inspect and
undo an answer — depend on a `plugins:` line answers the question at exactly the wrong moment. It
being seeded rather than registered also keeps `gate_action` from colliding with itself at every boot.
The bare asking gate (`askPermissionGate`, `plugin-api/host`) remains the floor under a
hand-assembled machine.

It reproduces today's behaviour — ask, offer standing answers, remember them — keyed
`(gate, subject)`, in its own settings namespace, with **lifetimes**: an answer is for *this time*, *this
session* or *always*, and the same three for a denial. *For this session* is the reason: "this work needs
my photos directory" should neither grant it for ever nor ask about every file. The prompt is three
independent choices — subject, lifetime, effect — sent as `FormField.axes`, which the web UI draws as two
dropdowns and the Allow / Deny buttons that answer (`FormAxis.submit`), reading as a phrase ending in its
verb; a frontend that draws only buttons ignores `axes` and is offered a short list of the common
combinations in `options`, each value encoding the same three coordinates (`1|session|allow`), so there is
one decoder and an answer is only ever a combination that was rendered. A call site may restrict the
lifetimes (`PermissionRequest.lifetimes` — keeping a function's grants across its edits is *session*
only), and a label names WHAT and never for how long, because the lifetime is the policy's to word.

Storage is one key per gate id holding a map from **scope** to answer — `'*'` everywhere, a session's
id, a `#` door sentinel — denials beside the allows under `deny:<gate>`. The map is required even for
`'*'` alone, rather than a bare list meaning "everywhere": one shape, so a reader never guesses which a
value is. The format before scopes (a list or `true` under the gate id) is migrated once, from the
**stored** document only — the host hands the policy a reader of it (`HostGate.create(settings,
stored)`), because migrating through the layered facade would copy a configured default into what is
stored, the seeding *Default plugin settings* rejects. An unscoped value that remains is therefore
configured, and is ignored with a warning naming it: read as an answer it would need a second shape for
ever, and ignored silently a configured denial would quietly stop denying. Where a session answer goes
is the policy's one option, `#session-store` (a `#` key is never a gate id): `memory` by default — out
of reach of every tool, being in no file, and gone at restart — or `settings`, under the session's id,
where it stays until forgotten, sessions never being deleted. `gate_action session-store` sets it, ungated:
it decides how long an answer a human gave is kept, never what is allowed, and switching to `settings`
moves the answers already held in memory so they survive the restart the switch is for. Memory is keyed by principal as well as
session, because a session can be shared and one principal's answer for their work is not another's.

**The most specific answer wins**, and the policy still parses nothing to find it: the call site lists an
act's subjects narrowest first, so a match ranks by how far below the stored subject the nearest subject it
covers lies (0 for an exact match, otherwise the depth of prefix between them), then by the earliest of the
call site's subjects at that distance, then this session's answer before one held everywhere, then a denial
before an allow should two tie. So an allow of `* node:fs` beside a denial of `* node:` admits that module
and no other builtin, a denial of one file (`* /p/.env`) or subdirectory carves it out of a directory
granted to any function or to one, and an allow of one function's directory reopens it inside a denial for
every function — the cases a flat "a denial always wins" rule could not express. Depth comes first because
a hierarchical gate's subjects vary along two axes (which function, how deep), and a stored ancestor
directory is none of them: ranked by the earliest subject it covered, a tree granted to one function
covered that function's exact file, and so beat a denial of the file for every function — the very
denial a user writes to exclude one file from a grant. Without separators every match is exact, and the
call site's order decides alone. The
subject outranks the scope deliberately: a broad answer for this session does not lift a standing denial
of something narrower. Where a call site's subjects form a hierarchy it says so, with
`PermissionRequest.separators`: a stored subject ENDING at one of them then covers everything beneath it,
so a grant for a directory covers its subtree, and `node:` every builtin, without the request listing
every level above its subject. Paths declare `[path.sep]`, module specifiers `[':', '/']`.
It was nearly a `covers` list carrying those ancestors, which grew with the depth of the tree. The
boundary is what keeps it sound: a bare prefix would let a file grant cover `notes.txt.bak`, and an origin
grant cover `api.x.evil`. That is why it is opt-in per request and absent for any gate whose subjects are
not a hierarchy (`http.secret`, `tool_function.connect`). Like everything else here it is the policy's: the gate
itself is still yes or no, so an installation authors defaults the ordinary
way (`default_settings: { '@matatbread/matbot-default-gate': { 'tools.overwrite': { '*': [bash, plugin] } } }` —
the name of the package the policy was published as until 0.5.0, kept because stored answers and every
installation are keyed by it; the "names no loaded plugin" warning exempts that one key, since nothing
loads it).
`gate_action` (`get` / `list` / `clear` / `deny`) reports the standing answers **in effect** and forgets them —
`list` one entry at a time (with its session, and whether only memory holds it), each with an id that is a digest of the entry, found by substring because a
subject's format is its call site's, and `clear` takes the ids back; forgetting a *denial* is itself gated
(`gate_action.forget-denial`), being a refusal the user chose, and asked EVERY time
(`PermissionRequest.lifetimes: []`, which also means no stored or configured answer decides it) — an
"always allow" there would let anything clear any denial unasked from then on. There is
deliberately no `set` for an allow, because the write path for a runtime actor is answering a prompt that names
the specific act. `deny` is the one exception, because it is the one thing that prompt can never be: a file
inside a directory already granted is never asked about, so there is nowhere to answer "deny". A denial only
narrows (under the ranking above, adding one turns an allow or an ask into a refusal and nothing into an
allow), but it is still gated, every time (`gate_action.deny`): a denial the model wrote unasked would be one
the gated forget then protected, and could refuse the management gates (`plugin.add`, `tools.overwrite`) at
will. `gate_action`'s own gates cannot be denied, since a denial of forgetting a denial could never be taken
back through the tool. Both are CONFIRMATIONS — asked every time, nothing remembered — so their prompt is
the question and two buttons, with no subject or lifetime to choose (those only say what would be stored,
and a "this time" there read as the lifetime of the denial it confirmed). Their buttons say what they do
(`PermissionRequest.answers`: Deny / Cancel, Forget / Keep), since "Allow" a denial is a double negative.
It is prose the policy renders, never a flag a frontend interprets: a frontend sees a form, not a request,
so no UI implementer learns a special case. It reports **answers, not a vocabulary**: a gate with no stored answer is absent
from the listing rather than described as "will ask", since an absent key says only that nobody
answered — what happens then is the call site's `fallback` and whatever policy is registered. A
built-in list of matbot's own ids would also be stale the moment a plugin contributes one of its own,
so there is none; the enumerable set is what the policy has written, and naming a gate explicitly is
how you reach one an installation configured (settings have no key listing). `__matbot_core__.overwriteToolsOnCollision` is **not** migrated — the standing
answer is re-offered the first time that collision comes round again, so adopt-once machinery would
exist to save one keystroke. (0.4.x warned an install still authoring it; 0.5.0 does not.)

**Honest statement of the property, and its limit.** The gate makes a privileged operation *pass
through a decision*; it does not put that decision out of the model's reach. The default policy keeps
its standing answers in plugin settings, so they live wherever the active `StorageBackend` keeps
settings — on the filesystem and SQLite backends, under `.data` (`.data/settings/`, `.data/matbot.db`).
That is read-write to `bash` (`docker-bash` mounts `settings/` and the SQLite files read-only), so on any
install that loads `bash` the model can write `{"plugin.add": {"*": true}}` itself (or the SQLite row holding it) and
every later install proceeds unasked (reads are not cached, so it
takes effect at once, not at the next restart). The same was true of the `__matbot_core__` key this
replaces, over a narrower blast radius. So the property is **"a privileged operation is decided
somewhere replaceable, and by default that means a human is asked"** — not "the LLM cannot change
this". (A *session* answer kept in memory, the default, is the one exception: it is in no file.) A deployment that needs a real boundary ships a gate with its rules compiled in, or keeps them
somewhere the tools it grants cannot reach; that is the policy plugin's problem by construction, which
is the point of the seam. And plainly: **a gate that auto-approves `plugin.add` has granted
everything**, a loaded plugin having full Node capability with no in-process sandbox.

**A standing answer is a decision, not a channel.** It applies at every door, including the ones with
no human behind them — `invokeTool`, a trigger, `POST /tools/:name`. "Always allow every `plugin.add`"
therefore means anything that can reach the HTTP endpoint (the model itself, through its own `http`
or `bash` tool) can install any specifier with nobody asked. That is what the answer *says*, and it is
why the per-subject form is offered first and is the one to reach for. Two other things a policy
author should be told rather than discover: the provider path **chains gates**
(`add-unverified` → `add` → `add-unlisted`), so one user-visible operation can cost up to three
decisions — `add-unlisted` last because listing the endpoint's models sends the profile's credential,
which nothing has agreed may go there until `add` is answered; and a collision
raised while a *replacement* policy plugin is itself loading falls to the host's seeded default.

---

## Module access from a `tool_function`

A body is a *constrained* place to compute, which is the reason to prefer it over a shell for data work:
an install that chose `docker-bash` over `bash` has not thereby handed `node:fs` to model-authored code.

**By name only.** A body imports a node builtin (`node:fs`) or a package already installed where matbot
runs (`lodash`, `@scope/pkg/sub`), never a path or a URL (`importableByName`, in `plugin-api`).
Downloading or placing code is what a *plugin* install is for: it is reviewed and versioned, and it has its
own gate. A body is too lightweight a thing to recommend it from. The rule is checked before anything is
asked, so nobody is offered a grant that cannot work. Paths would also defeat any standing answer, which
nests by string prefix: `./lib/../../x` "starts with" `./lib/` and resolves outside it. So a `.`/`..`
segment is refused in a package subpath too, since a package with no `exports` map resolves one as a path.
The gate, the runner and `IMPORT-GATE` each apply the rule.

Within that, three parts, and only the first two enforce anything:

1. **A per-call gate** — the control, and the default. `tool_function.import`, subject `"<function>@<version> <specifier>"`. The pair, not the
   specifier alone: *why is THIS function asking for `node:fs`* is the question being put, and a
   specifier-only key would let a brand-new function inherit every grant a reviewed one earned.
   `standing` carries the answers it may be remembered as (the exact pair, the module's directory, any
   builtin for a `node:` one, then the module across every function) narrowest first, **each with its own prose**: a
   subject is a key, and `#execute node:fs/` is a correct key and an unusable question — only the call
   site knows that `#` means a one-off body or that `node:` means any builtin. The policy does set
   membership over strings it never parses, and renders the label without rewriting it. What
   is NOT offered is the product of the two axes — "any function, any builtin" — because the options
   would multiply past what a prompt can carry; that is the gate-wide standing answer, and installation
   authoring.
2. **Refusal by rule is the gate's too** — a configured standing denial, `deny:tool_function.import`,
   with the `*`-subjects the call site offers (`'* node:child_process'` for every function; an entry
   ending at `:` or `/` covers what lies beneath it, `'* node:'` every builtin). It was a separate list,
   `permit_imports`, carried on the runner as `FunctionRunSettings.permittedImports` and checked in front
   of the gate, on the reasoning that "Always deny" refuses one function's one import while forbidding by
   rule is a different thing. Configured denials then took standing subjects, which made the two the same
   thing in two places, with two match rules that had already drifted once — so the list is gone and the
   setting is unread (the runner warns when it finds one, naming the replacement: unread silently, an
   installation's restriction would quietly become "ask at the call"). Deny-broad-allow-narrow needs the
   policy's "most specific wins" precedence, which the default policy is owed.

   **The type side derives from the same answers** (`ToolCheckOptions.importRefused`). A module the gate
   refuses the code being checked is not typed (`paths` is every builtin less the refused), and a literal
   `import(…)` of one is `IMPORT-GATE`, package or builtin. `function-tools` supplies the predicate,
   because the question is about one function under its own namespace (only it may ask under
   `tool_function`) and a check runs inside its tool call: one `ctx.gateSnapshot()` per check, asked with
   the SAME request builder the call uses (`importRequest`), under the subject the call would use — so the
   check refuses exactly what the call would. A package's exports are asked separately at the call, so a
   module is refused for the package only if refused for every export. Refused means a standing denial: a
   snapshot answering `fallback` is "nobody decided", which is asked at the call and may well be allowed,
   so it is typed. With no runner, nothing is passed — nothing routes the import to a gate, and a refusal
   reported there would be untrue. A redefinition is checked under its NEW version, which the lineage
   links only once the edit is permitted, after the check — so a define does not see a grant or denial
   given to the function's earlier versions; the call, which is authoritative, does.

   The checker's worker cannot be handed a predicate (it is a closure over this thread's snapshot) nor a
   list (packages are an open set), so it finishes the program, sends the literal specifiers it found back
   ONCE, and completes its findings from the answer. TypeScript stays off the main thread.

3. **The spelling** — a body writes `import(…)`, the real thing. `import` is a reserved word, so there is
   no binding to shadow; keeping the spelling a model reaches for first also keeps a **computed**
   specifier working (the argument passes through, so the gate sees the string the body built), and leaves
   the type-check reading the source as WRITTEN.

   **The runner is a PLUGIN** (`@matatbread/matbot-function-runner-node`), not part of the host, and not
   in a default install. That is the point: nothing in matbot requires a bound, withheld globals or a
   gated import, and everything this one does is reachable through the `FunctionRunner` seam alone — so an
   installation wanting different behaviour (a worker, a subprocess, another language) replaces the
   package and touches nothing else. Its setting is its own (`timeout_ms`, under `default_settings:` keyed
   by its package name); it was `function_timeout_ms` in the host's config, which could not work — the
   default runner has no way to implement it, so the host was parsing a question only a plugin can answer.
   0.4.x warned about the retired spellings in the config text; since 0.5.0 they are simply unread, like
   any other unknown key.

   **Its setting is reached the ordinary way, which means a tool** — `function_runner_config`
   (`get`/`set`/`clear`), because a plugin's settings are the plugin's to expose and the alternative was a
   restart per change. `set` only WRITES: nothing is rebuilt, because the settings are read per invocation
   (below), so the next run sees a change however it was made — this tool, another process, a hand-edited
   document. `null` means *revert to the installation default*, which is what `delete` means on a layered
   setting. The write is gated; being an override, it can widen a floor the installation authored.

   **The settings are read once per INVOCATION — never at boot, never cached across invocations**
   (`FunctionRunner.settings()`, held for a run by `runFunction` and handed back to the runner on
   `FunctionCall.settings`). The value is opaque to the consumer: `FunctionRunSettings` declares nothing,
   and a runner reads its own fields back off it. Whose settings they are is not the runner's to
   know: the settings store may be partitioned by principal (a profiles backend) or not at all, which is
   the storage implementation's business. A boot read answered for the boot principal for ever after, so
   one principal's narrowing was lost on restart and another's unrelated write could discard it; a
   per-principal cache would assume a partitioning nobody promised. An invocation, by contrast, has one
   principal throughout, so one read at its start is correct by construction. The gate's standing answers
   are read the same way, one snapshot per check. The same goes for a function's
   *definition* — a store may hold it globally or per principal — so nothing about it is assumed either.

   **A `FunctionRunner` is handed TypeScript and is the environment it runs in.** `compile(source)` takes a
   self-contained async-function expression — parameters and all, because a bare body is not valid alone
   (`return` at its top level is a syntax error) and every runner would otherwise have to wrap it before
   it could strip or parse it. What the runner does to get to something runnable is its own business.

   **The rewrite is internal and needs no typing.** The type-check runs at definition, on the source as
   the author wrote it (`ToolTypeIndex.check`), and compilation is separate and later — so substituting
   `import(spec)` for a private function is invisible to the type system, and there is nothing to declare.
   The consumer's gated loader is handed to each call as the compiled callable's first argument, because it
   closes over that invocation (the gate, the tool context, the function's name — the key a decision is
   remembered under). How it reaches the body — a parameter the runner names itself, a closure — is
   internal: node's binds it in a wrapper of its own per call, which is also why interleaved calls cannot
   tread on one another. Three shapes were tried before this and all three leaked the mechanism outward: an
   injected NAME the runner had to splice, SPANS it had to report, and a `RunnerProvisions` bag; the last
   dragged `function-tools`' calling convention into `plugin-api` as a declared symbol set, which was worse
   again.

   **Node's runner** (`plugins/function-runner-node/src/body-transform.ts`) erases with node's own `stripTypeScriptTypes` — which
   BLANKS types in place, so every line number in what runs is the one the author wrote
   (`transpileModule` reprints from the AST, inserting a `"use strict"` prologue and normalising
   formatting) — then walks TypeScript's AST for call expressions whose callee is the `import` keyword and
   splices each keyword's span. The compiler loads with `createRequire` on first use, which keeps
   `compile` synchronous and the ~250ms paid by the first body that compiles rather than at startup.

   **This was a hand-written scanner, and that is the thing to not do again.** Telling an `import(` in
   code from one inside a string, a template, a comment or a regex literal needs the previous significant
   token, and getting it wrong does not misread one token — it **desyncs**, so a quote further along
   swallows an `import(` that neither reading mentions, leaving an import with no gate in front of it and
   nothing reporting that. Two cases are undecidable without having parsed: a `/` after `)` may follow
   `if (…)` or `(a + b)`, and after `}` it may end a block or an object literal. Each patch bought one
   more case and left the class open — `)` was assumed to divide and silently lost the import after
   `if (f(x)) /a'b/.test(s)`, while routing it into the existing refusal path would have rejected
   `(a + b) / 2`. A parser also tells a method shorthand named `import` and a type-position
   `import('x').Foo` from a call, both of which had to be refused outright.

   **Nothing derived from the runner is cached, so nothing subscribes to it.** The obvious reflex, once the
   runner is a plugin that can arrive after a dts has been handed out, is for `ToolTypeIndex` to rebuild on
   a `services` registry change for the key. It was tried and reverted: the note is composed on every
   `dts()`, `check()` passes the withheld list fresh to each run, and the `paths` cache keys on the refused
   set's content, so a different answer is a different key. What IS cached is the source scan,
   which the runner has no part in — so subscribing discards a good TypeScript build to recompute
   something that was never stale. `function-tools` likewise recompiles a body against whichever runner is
   current, and the browser index rebuilds its note per call. **The rule that falls out: derive from the
   runner at the point of use, and there is nothing to invalidate.**

   **The one thing stored is a verdict, so a verdict names its environment.** A type-check is a claim
   about the environment it ran in, and that environment is a plugin: unload the runner, and a body that
   passed is still marked as having passed while its `import(…)` is no longer gated.
   `ToolTypeIndex.environment()` is a fingerprint of exactly what a check depended on besides the snippet,
   the tool types and the gate's answers — runner presence and the withheld set — stamped on the `ToolCheckReport` and stored by `function-tools` beside each
   definition, which compares it for **equality** and never parses it (what differs is the runner's
   business; all a reader needs is that the claim is about somewhere else). It is sorted and printed
   rather than identity-derived, because unlike the `paths` cache it has to survive a restart. Nothing
   re-checks on load — that is a worker program per stored function at boot, turning a report into a boot
   failure — so `list` says `checkedElsewhere: true` and `check` remains the way to re-verify. A `check`
   row is the verdict reached here and now, so it carries neither the flag nor the fingerprint, and a pass
   RECORDS the new fingerprint (a CAS on a stored definition, a `checked` marker for a session one) —
   otherwise the only way to clear the flag was to redefine a correct function. The
   tool types are deliberately NOT in the fingerprint: they are live, and `check` is how a caller
   re-verifies against them, whereas this names the thing a re-check cannot otherwise be prompted by. Nor
   are permissions: a verdict that passed refused none of the body's imports, and whether one is refused
   LATER is the gate's to report at the call, with a refusal naming its source — a type verdict is not a
   claim about permission.

   **Whether an import is GATED is whether a runner routes it.** The declarations said "each subject to
   permission at the call — you will be asked the first time" whenever no restriction was configured, which is a promise nothing keeps when there is no runner at all: the
   `import(…)` reaches the platform's loader unasked, and a body discovers the contradiction the first
   time it imports anything.

   **What a runner tells the type-checker is one array, and no text.** `import('node:os')` gets its types
   from `compilerOptions.paths` — one entry per builtin the gate does not refuse, pointing at the real
   `@types/node/*.d.ts` — never from the dts, which says nothing about modules. `paths` cannot ENFORCE a
   refusal (one builtin's declarations drag in the ambient `declare module 'node:…'` blocks of everything
   they reference, and a package resolves by ordinary lookup), and TypeScript cannot un-declare a global,
   so two structural rules close both holes: `IMPORT-GATE` from the gate's answers (above), and `ENV-GATE`
   from **`withheldGlobals`** — the identifiers the runner does not bind. That list is on the runner
   because a copy in the checker could not be kept in step, and a name shadowed but not rejected
   typechecks and then fails at the first call. The dts's prose is composed by the type index from it, so
   it cannot drift from what is enforced; a runner supplying prose of its own was tried and removed, text
   being the one part that needs no seam. Which modules are refused is NOT in the prose: that is an answer
   about one function, and the dts is shown to every one.

   **Absent ⇒ no runner, so none of it.** Nothing bounds the body, nothing is withheld, nothing rewrites
   its `import(…)`, and the loader handed to the call is never reached — so the body's import gets
   whatever the platform resolves. That is any install that did not add the plugin, and it is the
   **browser**, which could not enforce the gate anyway: with
   nothing withheld, `new Function('s', 'return import(s)')` reaches the platform loader whatever a
   transform concludes. The browser's own sandbox and permission UX
   is the boundary there, and its `ToolTypeIndex` says only the one concrete thing a body needs told —
   there are no node builtins. An install wanting the gate registers a `FunctionRunner`.

**No grant is narrow, and the label says so.** A builtin is not a safe tier: `node:child_process` runs
programs, `node:module` hands back `require`, and `node:process` is the very global the runner withholds.
A package is broader again, being loaded as **host code**: it is not compiled by the runner, so none of a
body's withheld globals apply to it, and its own imports are never gated again. So every import label
says it carries matbot's full access, and a package's also says it covers everything that package imports.

**Names are shadowed; the code builders refuse.** Withholding `process`/`globalThis`/`global`/`eval` (and
the phantom `require`/`module`/`__dirname`, which node's types would otherwise make typecheck and then fail
at the first call) works on NAMES, and every function's `.constructor` is not a name: it compiles a string
in the global scope, where the real ones are, and `(()=>{}).constructor('return process')()` was the
one-line way round all of it. So the node runner replaces the four function constructors and
`process.getBuiltinModule` process-wide with ones that refuse when the caller is a body, and are the
originals to everything else (`host-only.ts`; identity, `instanceof` and `.name` preserved). "The caller is
a body" is decided by the **nearest code on the stack**, skipping builtins and node's internals: the body's
own (compiled under a filename no module has) is refused — which catches a `toJSON`, getter or listener
the host calls long after the body returned — and a real module file's is allowed. With no code of
anyone's above it (a constructor handed straight to `promise.then` or a timer), an `AsyncLocalStorage`
span the call runs in decides.

**A granted package is trusted as itself.** "A real module file" is matbot's own code — a tool the body
called — or a package the user granted the body. Granting `imapflow` trusts imapflow, and the two dozen
modules it brings, to compile or patch what they like; it trusts neither the body that imported it nor
anything else installed. So a package's own code compiling a string when the body calls it is allowed,
and a callback of the body's that the package runs is still the body's. The corollary is stated rather
than closed: a package that EVALUATES its input (a template engine) evaluates the body's strings, and
granting it grants that.

`hostCall` (`FunctionRunner.hostCall`) is where control passes back to the host on the body's behalf —
its tool calls and a granted import — and leaves the span, so a tool's continuations, which have no code
of the body's above them, are its own. Its params are **copied before it**, in the body's code: anything of
the body's that crossed would run past the boundary as the host's. Hence the
invariant this rests on: **a tool that evaluates code its caller supplied must gate it or run it as a
body** — a tool runs as host code, so one that compiled what it was handed would be the escape. The check
itself reads nothing a body can replace (primordials captured at load; `Error`'s stack settings swapped by
descriptor), and fails closed: a body that makes the stack unreadable is refused, and so is everyone else
until a restart.

**When a body settles, the tool calls it left running stop; a call it makes later runs** (#114,
`makeToolBox`'s `stopInFlight`). A `Promise.race` loser, the siblings of a rejection in `Promise.all`, a call
left at an early return: each would run on, possibly as a whole agent turn, for a result nothing will read. A
call started after the body settled (a timer it set) is work it scheduled, and runs as it would in any
JavaScript. Refusing those was tried and removed: it stopped the tool call and not the timer, so it bounded
nothing and only made one use of an ordinary `setTimeout` fail at run time, after the body had reported
success. A body whose CALLER stops reading before it settles has been abandoned instead, and every call it
starts from then on is refused.

**A failure a body leaves behind is contained, not the process's.** A body can schedule work that outlives
it (`setTimeout`) and fail there: a throw, or a rejection nothing awaits. Node's default for an unhandled rejection or
an uncaught exception is to exit, so any body could end every session at once. The node runner listens for
both and decides by the body's span (`host-only.ts`), not by a stack: node reports each in the async context
it came from, so a rejection with no stack (`Promise.reject(1)`) is told apart as surely as one with a stack.
A body's is logged and goes no further. Anything else is handed back to node unchanged, because listening at
all turns the default off: a rejection is rethrown, and an uncaught exception is rethrown on the next tick
with the listener removed, which is node's own crash. When something else listens too (a host's own
policy, a test runner), that is left to decide. Without the runner nothing is contained, as nothing else is.

**What this is not.** A body shares this process's built-ins, so it can still REWRITE them —
`Object.prototype`, `JSON`, `Headers.prototype` — and whatever reads them later reads what it wrote. That
is deliberate interference, and no in-process runner can stop it: `--frozen-intrinsics` and
`--disallow-code-generation-from-strings` are process-wide, and broke ~110 of matbot's own tests between
them, and wrapping everything a body is handed is the `vm2` road. `ESCAPE-GATE` refuses the plain spellings
(`JSON.stringify = …`, `Object.defineProperty(Object.prototype, …)`, `__proto__`), and a computed one gets
past it. What the runner stops is a body REACHING past the gates, which is what an over-eager model does;
a boundary against tampering is a process of its own — a child that is not a matbot, handed a tool proxy
that runs tools in the parent, where whatever a body or its packages change is thrown away with it. A
separate `vm` context was weighed and dropped: a body holding a granted package's objects reaches the
parent's built-ins through them, and closing that is a membrane — the `vm2` road. A more thorough
in-process runner is possible; finding and closing what V8 exposes is that runner's project, not this one.

**A module wrapper is held to the same line** (`gate-fs-node`, through `ImportedModuleWrapper`). A body that
uses the module as handed and changes only its own objects is REACHING, however deliberate it looks, because
nothing shared was rewritten: a `Buffer` or `URL` altered after the call (the question and the call are apart by
a whole human answer), a stream's `path` assigned before its open on a later tick, `Utf8Stream.reopen`. So a
wrapper checks what is USED rather than what was passed: a path is read once and only that string goes on, a
stream is handed the guarded fs as its `fs` option so each open it ever makes is an ordinary guarded call, and a
link is resolved again in the tick of the call. A `Proxy` also needs its reflective traps, or a descriptor hands
back the raw function. Rewriting a built-in the gate reads is tampering, and stays open. Walking a prototype by
hand to node's own class rewrites nothing, and is closed without a membrane by the same caller rule as the code
builders: `ImportedModuleWrapper.hideFromBody` makes the prototype's `constructor` an accessor that a body reads
as a refusing stand-in and host code reads as itself, so `s.constructor === fs.ReadStream` still holds outside a
body. It is on the service, optional, rather than imported from the node runner, because what code is a body's is
the runner's knowledge: another runner's bodies would look like host code to the node runner's check, and
importing it would install the node runner's process-wide replacements into an install that chose another. A descriptor is the body's only if it opened it through the gate, per invocation, because fd-based calls
name no path and any other number is the process's own. `docs/SECURITY.md` *Known gaps in a function body's gates*
is the list, with what is ruled, what is not and what nobody has examined. Add a newly found gap there before
deciding whether it is acceptable.

**The criterion is reaching a capability without an import, so `Buffer` is NOT withheld** — it does no IO,
and node 24 has no other way to base64 bytes. It was, and that bought only a prompt in front of
`import('node:buffer')` describing it as full access, which teaches a human to click "always". What it
does expose is memory (`.buffer` of a small one is the shared allocation pool; `allocUnsafe` is not
zeroed), equally reachable after the import. Each name still on the list reaches all the others —
`process.getBuiltinModule`, `globalThis.process` — which is why there is no per-name setting to re-enable
one: it would be a single switch spelled as a list.

The withheld set and `ENV-GATE`'s list are **one list in two places**, and the checker's must track the
runner's: a global that is shadowed but not rejected typechecks and fails at the first call, which is the
one failure the check gate exists to prevent. The half that matters most is the half with no node types
behind it — `eval` is a `lib.es` global, so it resolves in every configuration. `Function` left the list
when the runner began refusing it by caller rather than by name; `ESCAPE-GATE` names it instead, with the
other spellings of reaching past the runner, and only when a runner is loaded — without one nothing is
refused, and saying so would be untrue.

**A grant names the function's LINEAGE, not only its name** — `<name>@<digest>`, the digest of the text
function-tools compiled (a package export's is the whole package's), computed by function-tools and never
taken from the body (`Function.prototype.toString` is the body's to override), then resolved to the first
version of the lineage it descends from. Redefinition is the one door the model controls, and keyed on the
name it inherited what the reviewed version had been granted; keyed on the digest alone, a function under
development asked for its imports and connections again at every edit. So the two questions are separate:
the GRANTS are general (they hold wherever the function runs, a background job included), and whether an
edit KEEPS them is its own gate, `tool_function.edit`, asked at a redefinition of a function that uses
`import(`, `fetch` or `WebSocket`, with "always, for edits to this function in this session" among the
answers. A permitted edit links the new digest to the lineage in function-tools' SETTINGS — never on the
stored definition, which a `docker-bash` script can write while settings are read-only there — so text
written any other way is a lineage of its own. The "any function" standing answer is unversioned. `#execute` is unversioned too, having no identity,
and its label already says a standing answer covers every one-off body. The same subject keys a body's
network gate (`tool_function.connect`).

**Types follow the reachable set, via `paths`** — one entry per module, never `types: ['node']`: every
builtin less those the gate refuses, so a body can be graded on what it may legitimately ask for. Each
builtin is its own question, asked with the call's own request, so a denial covers exactly what it would
cover at the call — `node:fs` alone, or `node:fs/` and its subtree — and an import the check refuses is
never one the call would allow. `paths` also pulls 65 files where `types` pulls 168. A path or a URL gets no types,
being unimportable; `IMPORT-GATE` refuses it at the check.

**`paths` cannot ENFORCE a refusal, though, so a structural rule does** — `IMPORT-GATE`, beside the cast
gate and `ENV-GATE` in the one checker. Loading a single builtin's declaration file drags in the ambient
`declare module 'node:…'` blocks of everything its own declarations reference (`node:fs` reaches most of
the rest through `node:stream`), whether a refused specifier then resolves depends on what `@types/node`
is reachable from the program root, and a package resolves by ordinary lookup whatever `paths` says — so
the `paths` set decides what is TYPED and the rule decides what is allowed. It also replaces what tsc says
when the module genuinely does not resolve: "Do you need to install type definitions for node?", about a
module the gate refuses, which the author cannot act on. The same advice reaches a GLOBAL (TS2591 for `process`, where ENV-GATE has no list
to fire from because no runner is loaded), and is replaced by the same reasoning: there is no
package.json to install into and the environment is the runner's, so the finding stands and only the
repair is rewritten. No second list of names does it — the trigger is tsc's own code, so it cannot drift
out of step with what the runner withholds. Only a literal specifier can be checked; a computed one is the gate's at the call,
which is where it was always going to be decided.

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
`switch`, and it isn't: `files` is emitted by workspace and by the profiles backend (a share); `sessions` has no plugin at all — the host wraps that store in
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

**`id` is the medium's address; `key` is the caller's.** Where a namespace derives its document ids
— settings slugs a plugin package name to satisfy the filesystem store's `/^[\w-]+$/`, and another
backend could hash or truncate — the producer also states the **`key`** it was addressed by, and a
consumer routing on identity compares that. Never re-derive the transformation in the consumer: a
copy keeps compiling after the rule changes and simply stops matching, and a filter that silently
never fires again is indistinguishable from "nothing changed" — the opposite of what an invalidation
is for. Absent `key` means the id IS the key (`sessions`, `files`), so a consumer that finds none
invalidates rather than assuming a mismatch.

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

## Sub-turns (`single_turn`)

`single_turn` (`core/src/single-turn.ts`; the turn itself is `sub-turn.ts`) runs a prompt apart from the
conversation and returns what it said. Without `tools` it is one request to a model (`singleTurn`): no tools,
no hooks. With `tools: true` it is a **sub-turn**, a full agent turn **executing within the session**, so it
has the session's id, principal, tools and gate answers. Its working is held in an ephemeral run's private
store, which is how a tool avoids writing into a session whose own turn is still running. That is an
implementation detail and not a session of its own: the id is only a key into that store. `turns` runs several
at the same time and returns their results in order. None of this is the `mode: 'parallel'` submission, which
merges its reply into the session it runs beside; these merge no messages, and that is what gives them a clean
return value. What does come back is the **markers its tools recorded**, below.

**One tool, because the two questions are independent.** Whether a piece of work has to act and whether its
pieces can run at once have nothing to do with each other: seven capitals "in parallel" need no tools, and a
code review needs them whether or not anything runs beside it. It was two tools, `single_turn` and
`parallel_turns` (every turn an agent turn), and the name did the choosing: a search for "parallel" found the
agentic one for pure language work, and nothing pointed one delegated agent turn at a tool called
"parallel". As one tool, choosing is filling in a parameter, and in probes on DeepSeek and Gemini models set
`tools` correctly from the prompt alone.

**Concurrency is inside one call, and has to be.** The runner executes a message's tool calls one at a time,
and that is right rather than an omission: the protocols leave the order to the client but warn that calls
sent together may depend on one another (Anthropic requires its computer-use batches to run in order), so a
runner cannot run them at once without knowing what each does. Turns listed in one `turns` call are declared
independent by the caller, which is what makes running them at once sound. It also works from a direct call
with no `function-tools`, and no sibling is left running after the call returns. In `turns` a failed turn is
an `ok: false` entry, since the others' results are worth having; one turn alone fails as the tool does.
`MAX_CONCURRENT_TURNS` queues rather than refuses, per call.

**One turn's fields or `turns`, at the root**, because every provider requires an object at the top of a
tool's input schema and Anthropic refuses `anyOf` there; the executor refuses both at once. The one-turn form
is what `single_turn` always took, so `tool.single_turn({ prompt }).text` still works. Results are positional,
not keyed by a name the caller chose: against a free-keyed root DeepSeek produced no valid call at all, and a
provider whose adapter strips `additionalProperties` (Gemini's must) was shown no turn schema. Positions are
typed through `ToolContract`'s third slot, so `const [review, summary] = await tool.single_turn({ turns })`
knows which has tool calls and which a transcript. **A field beside `turns` applies to every turn** —
`context` and `attach` add to each turn's own, the rest are defaults — because that is how a model writes
"all of these act": Gemini put `tools: true` there unprompted, and refusing it was the one way the flag came
out wrong. Code sets `tools` per turn, since that is what types each position.

**What a model reads is kept small, and that is a design constraint, not polish.** The description and the
contract text go out with every turn, and every field named in the result is spelt out in them. So the wire
form is one flat turn type (the `system`/`transcript` exclusions are in the call signatures and the executor,
not the wire), and a result is `{ ok, text, toolCalls?, messages? }` or `{ ok: false, error }`, without
`usage`: spend is accounting, already on the calling turn's ledger. The description is the probed one, word
for word: without its example neither DeepSeek nor Gemini delegated agentic work at all, and an example whose
prompts read like commands had Gemini write turns as `bash` calls. Change it only with a probe.

**No history is passed, because the caller selects.** The caller has already read the conversation, so what a
turn needs goes in `context`, once, written by the one party who knows the whole task; replaying history would
cost N times on every round for each turn to select the same things for itself. Where a turn only finds out
what it needs by working, it is told the session's id and can read the conversation.

**The tool set is the caller's.** There was an `exclude` list, and it presupposed that a model can judge from
a name which tools are dangerous or necessary. It also could not work by wrapping the registry, because a
body's `tool.x()` resolves from `machine.tools` whatever the runner was given. Session writes do not need the
protection anyway: they go through `run.write`, which waits for the calling turn without deadlocking. So the
guarantee is that the RUN writes nothing to the session, and a tool a turn calls can act as it could from the
calling turn.

**What a sub-turn's tools record comes back, as `single_turn`'s own markers.** A marker a tool yields is its
record about the session (data it kept, a function it defined), and a sub-turn is part of the calling turn's
work, so `runSubTurn` hands every marker its run produced to the caller, which yields them before its result
and the runner stores them as it would any tool's. Core's record of the RUN stays behind: its depth (copied
back, it would raise the session's), a truncation, a retraction, a hook that threw. There is no flag, because
nothing calling a sub-turn can know what its tools will record, so a model would set one at random. A turn
that failed carries nothing, as a crash must not commit half a turn. Inherited markers are not repeated: they are
the seed, which `own` excludes.

**Triggers stand down in a sub-turn.** A trigger judges what a person said and what was said back to them,
and a sub-turn has neither: its prompt is another model's, and its answer goes back to that model, whose own
reply is judged. A model cannot predict a hook outside its loop, so this is a rule, not an option. It was most
of what a sub-turn cost: two classifier calls each. `triggers` reads `subTurnDepth` (plugin-api) and
returns; the hooks are still dispatched, because `function-tools`' `screen` hook is how session functions
reach the turn.

**Depth is a marker in the turn's transcript** (`MAX_SUB_TURN_DEPTH`, `SUB_TURN_CREATOR`), because
`ctx.session` is the one thing every door hands a tool or a hook and a body cannot replace, so nothing has to
remember to forward it. A field on `ToolContext` would be lost at the first door that hand-picks fields, which
is what happened to `appender`. It does not survive a background job, whose turn is a session of its own. The
caller's other markers are copied in too, because a session-scoped function is stored as one.

**`system` is for a turn without tools, and with tools `attach` takes this session's attachments only.** A
sub-turn has the machine's system prompt, and a stored file attached by name would be written into the
session's media as the turn opened; a turn with tools can open a stored file itself.

**A sub-turn appends as any turn does.** Returning a value to the caller and writing to a conversation are
different acts, and a prompt can ask for either ("append the time here and return nothing"), so its appender
passes everything to the machine's, to any session it names. An append naming none goes to the calling
conversation (the run's own session is a private copy nobody reads), and a robo-submit says it came from a
sub-turn. It refused every append until 0.5.0, as a report the caller would relay anyway; that duplication is
the prompt's to avoid, not something to forbid.

**`messages` is opt-in per turn** (`transcript: true`). A tool result is a value in the transcript, so a direct
call would otherwise put N whole transcripts into the conversation before the model could reduce anything.

**Spend is charged to the calling turn by hand.** A sub-turn's entries land on its own head, which is thrown
away, and their roll-up into this tool's scope names a head the calling session does not have, so `flushUsage`
drops them. Re-recording them after the turn puts them on the calling turn, attributed to the tool call. The
other ephemeral callers (a run-now background job, a skill demonstration) lose that spend from the caller's
ledger today.

## Session appends

`services.SessionAppender` adds messages to a session — a background job's report, an answer merged back
from elsewhere. An assistant message is written and nothing runs; a **user message is a robo-submit**, run
as a turn (below). A running turn works on an in-memory copy of its session and
writes it back whole on exit, which is what keeps the store a set of completed turns; so an append is
checked at once (a missing session is reported to someone who can act on it) and **written by the
session's runner** once no turn holds that session (`SessionRunner.write`), then announced. With no turn to
wait for, that is at once, and the append settles once written, reporting a write that could not land. With
one, it settles on acceptance: the caller may be that turn, and awaiting the write would deadlock.

**Two notifications, deliberately.** The write raises the usual `ItemChange` (the session changed); a
`SessionAppend` beside it carries which message ids arrived — the one thing a re-read cannot recover, since
a turn adds messages too. A frontend draws those into the open thread; a chat bridge forwards them to the
chat that mirrors the session (telegram). `AppendMessage` is plain user/assistant text by construction:
an append arrives unasked into a history replayed on every later turn, so the arms carrying protocol state
(an unpaired `tool-use`, an unearned `thinking` signature) cannot be expressed.

**A background job never writes a session.** It shares its parent's medium but none of its parent's turns,
so a write from the job would land under one of them unseen and be undone by its write-back. The host seeds
an appender in every process and it refuses in a job; `matbot-background-jobs-node` registers one in the job
that forwards over the IPC channel to the parent, which applies it (as the job's creator, labelled with
the job from the channel — not from anything the job says). `session_action` rename/hide/unhide and
`session_edit` refuse in a job outright. The same channel carries what else the job changes back to the
parent's bus — **`ItemChange` only**: a registry change describes the job's own process (every job
registers its tools at boot) and relayed would rebuild the parent's type index and tool search per spawn.

An in-process job (`matbot-background-jobs`) is the same rule reached the other way: it runs on an ephemeral
run (`services.ephemeral`), so its own session is in a private memory store no other turn can see, and it
reports through the appender its runner hands tools as `ToolContext.appender` — the scheduler's, which labels
the message with the job and points it at the job's conversation. Its framing rides in its first message,
never the system context, which is machine-wide.

### Robo-submit

**An appended user message is answered.** It used to be written and left: a user message nothing answered,
which providers fold into whatever the person types next (adjacent user messages merge on the wire), so the
model read the two as one request, and a redo re-ran the job's message instead of theirs. No caller has a
use for that, so the role is the switch and there is no flag: `role: 'user'` hands the message to the
runner as a submission (`run.open`), which persists it when its turn starts and answers it, and the append
settles on acceptance with the turn's `traceId`. It is how a job that found something asks the conversation
what to do about it, rather than only saying so (`session_action append` with `submit: true`).

Each property of it is the default that keeps a person in charge:
- **`parallel`.** Any other mode stops or waits on the turn a person is having; parallel answers beside it.
- **Robo-authored, run as the appender's caller** (a job's creator, whose session it is) **on the session's
  own model** (the last message's `providerName` still configured, else the first configured). A job never
  chooses an identity or a model. Its blocks are `origin: 'robo'` whatever the caller says.
- **Alone.** An append holding a user message holds nothing else: anything written beside a turn that may
  run in parallel has no order to it.
- **Attributed to the model** (`withSenderShown`). Nothing else on the wire says who sent it, and a model
  told nothing answers a job's question as the person's ("as you asked…"). So the outgoing copy, never the
  store, opens it with `[Sent by <from>, …]`, `from` being `AppendMessage.from`, which whoever knows the
  sender sets (the jobs scheduler, the sub-turn), never the job itself. Fixed per message, so cache-safe.
- **Asked where the session is viewed** (`SessionPrompter`). A frontend hands a `prompt` with each submission
  it makes, so a turn started elsewhere had none, and every gate it met fell to its non-interactive
  fallback. frontend-web registers one that parks the question on the session as a submitter's would be,
  so the session shows `prompting` until someone opens it and answers. The runner counts unanswered prompts
  itself (`SessionStatusReport.prompting`), so that state is the same whichever frontend draws them.
- **Bounded by a person, not a counter.** Past `UNATTENDED_ROBO_SUBMITS` in a row with no message from a
  person between them, the runner asks before the next turn starts (`tools.robo-submit`, subject the
  session; *for this session* is the answer for a genuinely iterative job). Nobody to ask ⇒ it stops. Asked
  before anything is written, so a refusal leaves no unanswered message behind. A refused submission is
  `cancelled`.

**`origin: 'robo'` meant two things, and this split them.** It said who wrote a message and, implicitly,
that it was not a new request — triggers skipped a wholly robo user message and looked past one for "the
last genuine user message", which is right for a `followup` resubmit, which continues the turn before it. A
robo-submit is machine-written AND a request. So the second meaning is now its own fact: the host stamps a
robo-submit's message `metadata[ROBO_SUBMIT]` (via `SubmitOpenOpts.metadata`, an in-process field no
frontend passes through from a client), and `isRequest(message)` — a person's message or a robo-submit —
is what triggers and the turn counter ask. `origin` is left to presentation. The mark is on the robo-submit,
not the resubmit, so history written before it reads exactly as it did.

## Session data (`session_data`)

`plugins/session-data` keeps a JSON value in a session as a **marker** and reads it back by a short id, so a
tool's output can be handed to a later step — a query's rows to a chart, turns apart — without the model
reading it. Being a marker, an entry is private to its session, shared when the session is, carried by fork and
compaction, gone with a cut back past it, and never sent to a model. The write that matters is from a
`tool_function` body (`const rows = await tool.q(…); return tool.session_data({ action: 'write', … })`): what
the model reads back is the entry's id, description and type, never its data. Neither the producing nor the
consuming tool knows the plugin exists; the body is the glue, which is why a ref is a plain id and not a
scheme: it only ever goes back to `session_data`.

**A marker from a nested call is kept.** `makeToolBox` passes a callee's `marker` events to its `onEvent`,
which `function-tools` yields as its own. It kept only the result, so a callee that recorded something
reported success and its record was gone — a session `define` made from a body said "Defined" and did not
exist the next round.

**Write-once, capped at 64KB of JSON** (`MAX_ENTRY_BYTES`, refused as `invalid` with the size, saying to use a
tool that takes data of that size — naming none, because which storage tools an install has, and what it calls
them, is not this plugin's to know). The session document is written whole at every turn's start and end,
which is why session *media* is always a reference; this is the deliberate exception, and the cap is its price.
An entry never changes (`drop` is a later tombstone, which frees nothing), so a fork shares no mutable state.

**Readable within the call that wrote it.** A tool's markers reach the session when its call ends, so a body
that writes and reads would find nothing. The pending writes are keyed on the session OBJECT the call was
handed: every call inside it is handed that object, and the runner moves on to a new one carrying the
markers, so the cache covers exactly the window and is never cleared. Not the quiescent edge — that is
machine-wide and says nothing about when one call's markers land. A sub-turn is a new object, so it does not
see a write its caller has not finished.

**A registered tool with one contract, typed per session at check time.** `read` is a `Call`-slot generic,
`<K extends string>({ id: K }) => Promise<SessionDataRead<K>>`, which looks `K` up in this tool's key of
`SessionTypes` — empty in every declaration. A check made on a session's behalf (`execute`, a session
`define`, its re-`check`, `types`) appends what `sessionType(session)` answers: a map from each held id to the
type inferred from its value (`shapeOf`). So a literal id read in a body is typed exactly, and its rows pass to
a typed tool with no narrowing; an id not held, or known only at run time, reads `unknown`. A global function
is checked with nothing appended, so its reads are `unknown` and narrowed, and a read the session running it
does not hold fails at the call, reported. That is the reason it is registered: it was a turn tool, rebuilt
each round with an arm per entry, and a global function could not call it at all — a rule borrowed from
session functions, which genuinely exist in one session only, where `session_data` exists in all of them.

Why each piece is the shape it is:
- **The type is inferred from the value, not the writer's static type.** An entry never changes, so a type
  describing this exact value is exact; the static type of what was written is wrong after the JSON round
  trip (a `Date` reads back as a string, `undefined` and methods are gone), and a direct model write has none.
  It is re-derived on every read rather than taken from the marker, because it is spliced into a check as
  source and a stored string is whatever last edited the session file.
- **A map looked up by one generic, not an overload per entry.** Checker time and the size of "No overload
  matches this call" grew with every entry; a lookup costs the same however many a session holds.
- **`SessionTypes` lives in plugin-api** because the generated tool types are one file that copies a package's
  own declarations into itself, and an augmentation cannot add a new name to another module: plugin-api is
  the one module every check resolves. Keyed by tool name and written by the checker, so a tool fills its own
  key and no other.
- **The description never changes.** It listed the held entries, so every write changed a tool definition,
  which sits ahead of everything in a provider's prompt cache and discarded it for the whole conversation.
  `list` finds what a session holds.
- **The written type is not carried through a just-written id.** `write<T>` returning an id that `read` turns
  back into `T` is the JSON round-trip lie again, and the body already holds the value it wrote.

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

**A tool's marker says which calls produced it, and the host says so, not the tool** (`by: CallFrame[]`,
outermost first). The runner stamps the call it made (`tool`, the registering `plugin`, `callId`); a
`makeToolBox` stamps each nested call it makes (`tool`, `plugin`), ahead of the frames its own callees
added; `single_turn` hands a sub-turn's markers back still carrying the frames its runner stamped. The
stored block is built from `creator` and `data` alone, so a `by` on the event a tool yields is never read,
and the frames a nested call carries up ride on a symbol only `/host` writes (`withCallFrames`), which JSON
cannot carry and so model-authored data never can.

It exists because a reader often needs to know who WROTE a record without trusting the record: an entry
of `session_data` that a governed query wrote itself, through a nested call, is a different fact from the
same rows read back and written again by a composed body, and only the frames tell them apart (the body's
write has `tool_function` above `session_data`, the query's has the query tool). Decide on `plugin`, the
host's stamp of who registered the tool; `tool` is the name it was called by, which a wrapper or a reload
can change. `callId` is on the runner's frame only, because only that call is recorded in the transcript to
be joined to. A marker with no `by` came from no tool — a hook, the runner's own bookkeeping, a trigger's
dispatch, or a session written before 0.5.0 — and its absence answers nothing.

---

## Media

Two paths, no overlap, distinguished by **who owns the bytes**:

| | Carried as | Resolved by | Lifetime |
|---|---|---|---|
| **Tool media** — the model pulled it | nothing; wire-only | the runner, from the tool's `model-content` event | dies with the turn |
| **Session media** — a person attached it | a `file-ref` in the message | the runner, via `MediaStore` | dies with the session |

The runner therefore never guesses which store an id belongs to: it only ever resolves session media.
A model referring to a *workspace* file transfers no ownership and needs no new mechanism — it calls a
tool, which pulls (below): `workspace_action show`.

### Tool media — the pull path

The model **pulls** media; nothing pushes it. A tool yields `{ type: 'model-content', content: ModelContent[] }` —
the inline arms of `MessageContent` (`image` / `document` / `audio`), bytes plus a mime type. The runner
pins them directly after the tool message they answer and splices them into the **outgoing copy** for
the rest of the turn. The mirror of a marker: a marker is persisted and invisible to the model; media is
visible to the model and never persisted.

**Never persisted** — the transcript records what a tool *returned*, not the bytes it *showed*, so a
session cannot accumulate base64 and no exit path has to remember to strip it. A later turn needing the
bytes calls the tool again.

This is also why a tool that has bytes cannot serve them through its *result* instead. A result is a
value in the transcript, so base64 there is 4/3 of the file persisted **and** re-sent every later round,
for something the model cannot see at all — the exact trap `workspace_action read` + `encoding: 'base64'`
was, before `show` existed. A tool holding something the model should look at yields `model-content` and
returns metadata; the two are not interchangeable, and a description cannot substitute for the event.

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

`assembleMachine` seeds the host's own file area as the boot default, so attachments work out of the box; the seed
goes in the *registry* rather than on the base object, because `unifyServices` resolves an own property
first and a member spelled there is one `register()` could never reach. Unregistering reverts to that
default rather than turning media off.

**A model names an attachment by the id it is shown beside it** (`<message id>#<index>`,
`withAttachmentsShown`), on the outgoing copy only. A model never sees a `file-ref`: it gets bytes, which carry
no id or name, or a note. The id is an address within the session, so it can only find that session's
attachments, and it is how `single_turn`'s `attach` takes one, with tools or without. It adds a stable
line to the wire of a session with media, which costs a few tokens and no cache.

**Residency is a byte budget** (`MEDIA_RESIDENCY_BYTES`, 8MB), walked newest-first, computed **once per
turn**. Beyond it a `file-ref` is left alone and the converters degrade it to `[Attached file: x]` —
honest, already written, and the file is still fetchable. A byte budget rather than a turn count because
the cost is denominated in bytes: three turns is a fine window for a thumbnail and a ruinous one for a
40MB PDF, and a count cannot tell them apart. Recomputing per *round* would let a message fall out of the
window between two provider calls, busting the prompt cache and leaving the model referring to something
no longer there.

**Refuse at the boundary, naming the file** (`MediaRejectedError`, with `reason`). The alternative is a
provider 400 part-way through a turn the user already believes was sent, with no way back. Nothing is
enqueued on a refusal, so there is nothing to unwind. Caps: 50MB/session, and per-file **is** the
residency budget rather than a second number — a file larger than the outgoing-copy window can never be
resident, so admitting one only buys an attachment that is accepted and permanently invisible. The
session total is **derived** by summing what the store holds, never a counter, which is wrong after a
restart, a swap, or anything deleting a file behind it.

Two refusals are about *what* rather than how big. A type no endpoint decodes (HEIC off a camera roll,
SVG) is refused because `image/*` is the one arm a provider *tries* to decode — everything else degrades
to a text note, but a bad image 400s the request, and by then the `file-ref` is in history where it fails
every later turn too. And a caller-supplied `file-ref` is checked against the session that owns it
(`sessionId` + namespace; `allowed` cannot substitute, every put setting it true), because a `fileId` on
the wire is the client's word about which bytes to send and the resolver inlines what it is handed. Both
live at the submission boundary for the same reason as the size caps: it is the only point that knows the
session *and* has a channel to say no — the runner could only drop a block silently, mid-turn, for
something the user watched itself attach.

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

## Reporting failures

**matbot reports; it does not retry.** Whoever called — a person, a frontend, a model that delegated the
work — decides whether to try again, as a reasoned choice. A retry inside matbot takes that choice for
them, hides the failure, and may repeat work with side effects (a parallel turn's tool calls, a write that
landed before its answer was lost).

That choice needs to know whether trying again could help, which a message alone does not carry. So a
failure has a **`FailureClass`** (`plugin-api` `errors.ts`): `unavailable` (may work later), `denied`
(not allowed; trying again changes nothing), `invalid` (the request is wrong; trying it unchanged changes
nothing). It is a property on a thrown error (`withFailure`, read by `failureOf`) and a field on both
`error` events, and it describes what happened, never what to do. Three words because three is what a
caller does differently; a fourth needs a matbot caller that branches on it. The words are the ones
`SkipKind` already used for this exact distinction (`edit-session`, `background-jobs`), plus `invalid`
for what `TOOL_INPUT_INVALID` and `MediaRejectedError` already meant.

**Only the layer that raised a failure classifies it.** A store knows that `SQLITE_BUSY` clears, an adapter
knows what Anthropic's `overloaded_error` means; core does not, and does not guess from shapes: a reset
socket and a failed DNS lookup reach a caller as the same `TypeError`, and a browser's carries no cause at
all. Unclassified is a real answer and is said as one. Core carries a class unchanged from where it was
raised to where it is read: a turn's `error`, a tool result (`{ error, failure }`, beside the message the
model reads), `single_turn`'s text, an HTTP status (`FAILURE_STATUS`). A type that is wire text spells the
words out rather than deriving them (`Extract<FailureClass, …>` is what a model would read).

**Detached work must not reject.** The turn pump runs with nothing awaiting it, so a rejection is
unhandled, and under Node's default that exits the process — every turn on every session with it (#115).
Each failure the pump can meet is therefore reported where it belongs: the turn's own `error` (the
per-turn `try` starts at the turn's first await, not at its run, so a store read or a provider resolving
before the run is that turn's), an `error` against a parallel reply that could not be written, a log line
for accounting. `startPump` is the one way a pump starts, and logs whatever else arrives; it only logs,
because by then the drain's own `finally` has run and another pump may own the state.

**A failure report must be true, so `open()` awaits nothing after queueing a submission.** It used to read
the session back for the caller after queueing it, and a failed read told the caller a submission had
failed that was already running; sent again, it ran twice. A submission's view (`SubmittedView`) therefore
has no `session`, and `open()` throws only before anything is queued. A session that does not exist is the
submission's `error` (`invalid`) on its stream.

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
It holds the current minor series; the previous ones are in `docs/CHANGELOG-v0.4.md`, linked from its
foot.

**Sections:** one `## <version>` per release, newest first; work not yet versioned goes under
`## Unreleased` until the release it lands in is cut, then folds into that version's section. Within
each, four categories in order:
1. **Breaking changes** — core contract changes
2. **API gaps filled** — new core API surface
3. **Bug fixes** — core fixes
4. **Optional** — new/updated plugins/frontends/apps, grouped by plugin