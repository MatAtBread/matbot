# @matatbread/matbot-core

## 0.4.10

### Patch Changes

- Install defaults for plugin settings, from the config (`#51`).

  `default_settings:` in `matbot.yaml` — `BrowserConfig.defaultSettings` in the browser — supplies the
  install's value for any key a plugin keeps in the settings store, keyed by plugin package name (the
  settings namespace). A project can now ship an opinionated install without a wrapper package per
  plugin: identity is loader-derived from the package name, so wrapping a plugin purely to initialise it
  moves its settings namespace to the wrapper, orphaning what the install already stored and colliding on
  every tool name if both load.

  It is a **read-only floor**, and the whole design is one rule: reads are layered, writes are not.
  `settings.get` returns the stored key if present, else the install default, else `undefined` — which
  lands above a plugin's own `?? codeDefault`, so config beats code and no plugin needed changing. The
  CAS write path reads the stored document only, so `set` persists exactly the key it was given, and
  `delete` means "revert to the configured default" — what every existing `clear` action already meant.
  Nothing is seeded and nothing is written back: editing the yaml therefore still takes effect for every
  key nobody overrode, a plugin or provider update cannot destroy a default, and it applies to every
  principal rather than only the one that booted. A key naming no loaded plugin is warned about at boot,
  since it would otherwise look like it had worked.

- The config parser no longer returns half a file.

  An unparseable construct made the parser `break` its enclosing loop, which returned what had been read
  so far and left the rest of the document **silently discarded**. A stray `-` in `plugins:` — the dash
  alone on its line — dropped every plugin after it and every top-level section below it, `providers:`
  included, with no error: an install that boots and behaves as though half its configuration had never
  been written. It now throws, naming the line and what it could not read.

  Two constructs it could not read are now read. A bare `-` takes the block indented beneath it as its
  item value (the branch for it existed but was unreachable, because the dash test required a trailing
  space), and a quoted mapping key is unquoted like any other scalar — `'@scope/pkg':` addressed a key
  literally spelled with its quotes. YAML's compact mapping in a sequence entry (`- key: value`) stays
  unsupported and is now rejected rather than mis-read: telling it from a plugin specifier needs the
  spec's colon-space rule, without which `- https://host/p.ts` parses as a mapping keyed `https`.

  - @matatbread/matbot-plugin-api@0.4.10

## 0.4.9

### Patch Changes

- f6d546d: `bash` ends when the process it waited for ends, and takes every process it spawned with it.

  `bash -c` forks each pipeline stage as its own process, and the plugin got both halves of that wrong.
  Its abort handler and its `timeout` signalled the **direct child** only, with no `detached` and therefore
  no process group to signal — so `find / … | head -5` lost its shell to the SIGTERM and left `find`
  running, reparented to init, traversing the whole filesystem with nothing in the app able to stop it. And
  completion hung off `'close'`, which needs the process to have exited **and** every stdio stream to have
  reached EOF — so the orphan holding the script's stdout meant the event stream never terminated. Together
  they made the turn unrecoverable: the session sat at "working" for ever while every abort reported
  success, because the abort worked and the tool call was simply unreachable. Measured: `'exit'` at 14ms,
  `'close'` at 5021ms behind a five-second orphan.

  So the script now gets its own process group (`detached`, POSIX only — Windows keeps the direct-child
  kill), every stop signals the negative pid and escalates SIGTERM → SIGKILL after a grace, and `'exit'` is
  authoritative for completion: `'close'` still wins when it arrives, otherwise an idle window (reset by
  each chunk, so a real drain of the pipe buffer completes) ends the call and says so in `stderr` rather
  than reading a pipe nothing is waiting for any more.

  Two bounds come with it, because an unattended host has no operator to restart: a **default `timeout` of
  ten minutes** (a caller who needs longer passes a bigger number) and a **100000-byte output cap**,
  matching `docker-bash` — the two same-named tools should not behave differently, and a runaway that only
  stopped accumulating would still spin to the timeout.

  A third bug fell out of the same code: a signal-killed script gives `code === null`, which the success arm
  read as **exit code 0** — so a timeout kill and an abort both reported a clean run. A kill is now reported
  as a kill, naming the reason. `docker-bash` carried the same misreport in its own `close` handler and gets
  the same arm; there it can only be reached by the _local_ `docker exec` client being signalled, since an
  in-container signal death is propagated by `docker exec` as its own numeric exit code (137, …).

  In `core`, an aborted turn no longer depends on the tool's cooperation. The runner iterated executors with
  a bare `for await`, so any tool that never returns held the turn open for ever — `bash` got there through
  inherited file descriptors, but a generator awaiting something that never settles or a bridged remote that
  went away do too. Once the turn is aborted the read is bounded (`ABANDONED_TOOL_GRACE_MS`, 30s): the
  runner stops reading, warns, and records the call as interrupted, which keeps every `tool_use` paired with
  a `tool_result`. Only armed on abort, so a long-running tool on a healthy turn is never cut short, and a
  tool cleaning up after a cut-off is still waited for.

  - @matatbread/matbot-plugin-api@0.4.9

## 0.4.8

### Patch Changes

- b550d6a: `about_matbot` reports the system prompt in force, broken down by the plugin that contributed each part.

  **The model could not see its own system prompt.** It is assembled once per submit from every registered
  `SystemContextContributor` and never persisted, so there was nothing on the session to read back and no
  tool that reported it — asked "what are your instructions?" or "why do you keep doing that?", the model
  could only guess, while the answer sat in a registry it had no route to. `about_matbot` already answered
  the adjacent questions (which model, which provider, which harness version), so it answers this one too:
  `systemPrompt` is the joined text exactly as the turn received it, and `systemContext` is the same
  content kept apart, each part carrying the name of the plugin that registered it. Attribution is the
  half that makes it actionable — "the skills catalogue put that there" names the thing to change.

  **`SystemContextRegistry` gains `parts(ctx)`**, and `build()` now derives from it: one traversal and one
  filter, so the text sent and the breakdown reported cannot drift into disagreeing about what is in the
  prompt. Breaking for a host that hand-rolls the registry rather than constructing core's
  `SystemContextRegistryImpl` (nothing in this repo does); `build()`'s own signature and behaviour are
  unchanged, empty contributions dropped and `null` for none at all.

  **`createAboutMatbotTool(version)` is now `createAboutMatbotTool(version, services)`** — it needs the
  live machine to rebuild the prompt, the same second argument `createSingleTurnTool` already takes.
  Rebuilt rather than recorded: against the turn's own session it is the same text, and where a
  contributor's source moved mid-turn (a skill added, a plugin loaded) it correctly reports what the next
  call will carry rather than what the last one did.

  **The web UI puts it behind the version in the header.** Clicking `matbot vX.Y.Z` runs `about_matbot`
  over HTTP and shows the harness line, the provider, and the system prompt broken down per contributing
  plugin with a character count each — the one thing the UI had no window onto at all. Re-run on each open
  rather than reusing the copy taken at boot, because the interesting half changes while the page is up (a
  plugin loads, a skill is flagged for the catalogue) and a stale answer to "what are you being told?" is
  worse than none. It names the provider selected in the tab rather than the tool's `currentProvider`, which
  is absent here by construction: the direct tool endpoint builds a session-less context, so there is no
  turn to report — and the overlay says which it is showing rather than implying the tool answered.

- Updated dependencies [b550d6a]
  - @matatbread/matbot-plugin-api@0.4.8

## 0.4.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.7

## 0.4.6

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
  - @matatbread/matbot-plugin-api@0.4.5

## 0.4.4

### Patch Changes

- 99152f3: The quiescent edge is the drained queue, not the end of a turn.

  A deferred machine mutation — the `StorageBackend` swap, the mount table's batched notifications —
  landed whenever no _turn_ was in flight. But the pump does a great deal of store work outside a turn:
  it re-reads the committed document for `followup`, appends markers to it, rewrites it for a retract,
  and persists the next queued turn's user message before that turn opens. All of that was quiescent, so
  a mutation could land in the middle of it — the turn's write-back going to one backend and the
  followup marker appended to it in another, which is precisely the split the deferral exists to
  prevent. A two-turn queue reached the "idle" edge six times mid-flight.

  `machineBusy(fn)` is the new `/host` primitive: the half of a context switch that is not about
  identity. `contextSwitch(principal, fn)` keeps its meaning and signature and is now literally
  `machineBusy` + `runAs`. The pump holds the machine once around its whole queue and `runAs`es per
  item, each carrying its own submitter — the same boundary accounting already flushes at, for the same
  stated reason that the end of a turn is not a moment anything can be totalled or swapped at.

  It is a wrapper rather than a `begin`/`end` pair on purpose: the hold is released on every exit,
  including a synchronous throw and a rejected promise. A stranded counter would be unrecoverable —
  every later flush no-ops forever, and the only symptom is a deferred mutation that never happens.

  **A flusher may now be asynchronous.** `onContextQuiesce` takes `() => void | Promise<void>`, and
  returning a promise makes the edge wait rather than merely start the work; `quiesced()` is the other
  half, awaited by an operation that must not overlap deferred work. The pump awaits it before taking
  its copy of the session, so an edit deferred out of one turn has landed before the next turn reads it.
  Flushers are invoked in registration order and then settle together; the synchronous prefix still runs
  inline, so a mutation staged and landed with a bare `flushIfQuiescent()` is in effect before the call
  returns.

  The edge does not give exclusivity against the rest of the machine, and cannot: once any flusher
  awaits, an HTTP endpoint can accept a request and run a tool call inside that window — so serialising
  flushers against each other would remove one source of concurrent mutation and leave every other one.
  Contention over a service is the service's to resolve — a `Store` answers it with compare-and-swap —
  and the sweep's job is to make contention rare. A backend swap is staged, never applied, while a flush is
  settling, which narrows one further window: compare-and-swap answers "did this document change?", not
  "did the medium change?". That exposure is not new and is not the flushers' — an HTTP tool call has
  always been able to straddle a swap the same way — and the fix belongs in a `cas` that checks it is
  writing to the backend it read from.

  What an embedder observes is the timing: a `register()` from inside a turn now takes effect when the
  session's queue drains rather than at that turn's end, which for back-to-back turns (a `followup`
  resubmission, a retract-and-rerun) is later than before. The mount contract already promised only
  eventual, ordered delivery and explicitly not timing. Frontend entry points are unchanged: a web
  request or telegram message still uses `runAs` and deliberately does not hold the machine, its scope
  spanning a long-lived stream.

- 20d87fe: `StorageBackend.namespaces?(): Promise<string[]>` — a backend can now be enumerated, not only addressed.

  `createStore` is addressed BY name, so a caller could only ever read a namespace it already knew
  about. Nothing could traverse a backend: copy one into another, audit what is stored, or report on a
  `.data` directory. `namespaces()` supplies the missing half.

  **Optional, because absence is a type.** A backend over a medium with no listing operation cannot
  answer and must not guess — a caller that needs a complete list degrades to being told the namespaces
  explicitly. It is specifically NOT implemented as "the namespaces `createStore` happened to be called
  with this session": that is a lower bound wearing an answer's clothes, and a traversal built on it
  silently skips whatever no plugin has touched. Files are excluded — they are their own axis with
  their own enumeration (`FileStore.list`), not a namespace among the document stores. A namespace
  holding no documents may be omitted, and results are sorted so a diff of two backends is stable.

  Implemented by every backend, each of which reaches it differently:

  - **filesystem** — a directory is a namespace when it _directly_ holds at least one document. A
    content test, not a name test: `.data` is a shared root and anything may put a directory there, so
    naming exclusions would mean this backend carrying a list of other packages' directories. Falling
    out of "directly": a plugin's working state and a nested partition root are both excluded because
    neither holds documents of its own, which is true regardless of who created them.
  - **sqlite** — via a new `namespace_registry` table. The table name is derived by replacing every
    character outside `[A-Za-z0-9]` with `_`, which is not invertible (`a-b` and `a_b` both give
    `a_b_store`), so `sqlite_master` alone cannot answer. Databases written before the registry existed
    are backfilled on read by stripping the suffix — exact for any namespace whose characters survived
    the derivation, and self-correcting for the rest once their plugin calls `createStore` again.
  - **browser** — one IndexedDB database per namespace, so `indexedDB.databases()` is the enumeration.
    Where that API is missing (older Firefox) it throws rather than falling back to the namespaces
    opened this session, which would silently under-report.
  - **google-drive** — one folder listing under the root, excluding the blob folder.
  - **profiles** — the namespaces the CURRENT principal would actually read. Routing is per namespace,
    so candidates are gathered from every partition the principal can reach and each is kept only if
    its own route sends it to a partition that really holds it; listing the union unfiltered would
    report another profile's isolated namespace as present, which is what partitioning exists to
    prevent.
  - **CachingStorageBackend** — forwards only when the wrapped backend has it, assigned per instance so
    `'namespaces' in backend` stays truthful. A decorator that always declared the method would answer
    for backends that cannot, turning a degradable capability into a runtime failure.

- e65e2a3: A store write can no longer cross a `StorageBackend` swap.

  Exactly one backend is active and nothing is migrated between them, so a caller that read a document
  before a swap and wrote it after was addressing two media with one read-modify-write — and nothing
  could see it. Compare-and-swap asks "did this document change?", which the incoming backend answers
  about a document it never issued, usually "there is nothing here"; an unconditional `set` then
  recreated the previous backend's document inside its replacement, and a session had silently migrated.
  It is reachable wherever a read and a write straddle the swap — an HTTP tool call always could, and
  deferred quiescent-edge work now can too.

  `mediumGuard` (`@matatbread/matbot-core/storage-base`, wrapped around each store proxy by both hosts)
  puts the check where the consequence lands rather than asking every caller to know something only
  storage knows. The version is the only token tying a read to its write, so it carries the medium:
  stamped on the way out, checked and stripped on the way in — stripped because most write-backs reuse
  the version they read (`store.set(id, { ...doc, title })`), and a persisted stamp would be stamped
  again on the next read. An unstamped version is always accepted, being a document the caller minted
  rather than read. A stale `cas` returns `{ ok: false }`, the loss every caller already handles; a stale
  `set` throws, having no other channel.

- @matatbread/matbot-plugin-api@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.3

## 0.4.2

### Patch Changes

- One shared contract for the `plugin` and `provider` tools, and named result shapes that can be augmented.

  Both tools have a node and a browser implementation, and each declared its own `ToolContracts` arm. A registry key is registered by declaration merging, so two declarations are legal only while identical — these were not, and `buildMatbotToolsDts` never read the Program's diagnostics, so one won on file order and its shape was emitted as the contract. In any tree containing `plugins/`, the browser shapes won, and node's generated code was graded against them: the check loop rejected `providers[].hasCredentials` (what node returns) and accepted `providers[].hasKey` (`undefined` at runtime).

  Both now declare `PluginToolContract` / `ProviderToolContract` from plugin-api. Node's names win, so the browser tool renames `hasKey` → `hasCredentials`, `adapter` → `module`, `ProviderRow` → `ProviderSummary`, and takes `ModelParameters` for `parameters`. `FailedPlugin` moves from core to plugin-api (still re-exported from core). Result shapes are named, exported interfaces, so a host overriding a builtin tool can augment them instead of being unable to describe its own return.

  Duplicate registry declarations are now reported rather than silently resolved.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2

## 0.4.0

### Minor Changes

- Two turn-loop bug fixes, plus the plugin-api 0.4.0 surface changes re-exported.

  **Bug fixes**

  - A provider call that fails mid-turn now commits the rounds that succeeded. Nothing is written mid-turn,
    so the failed-call exit returning without a commit discarded the whole turn — and the multi-round case
    is the tool-using one, so an upstream 500 on round 3 lost two completed rounds of assistant messages and
    tool results the frontend had already drawn.
  - A plugin's `services.mounted` interests are dropped on unload. The only cleanup path was an aborted
    `signal`, which is optional, so a plugin that omitted it left a live handler firing into a torn-down
    closure — one more per reload generation, silently.
  - A tool-name collision can no longer crash the process or revive an unloaded plugin's tool: the
    collision branch is the one `await` in `registerTool` with no caller to own its outcome, so a throw
    there was an unhandled rejection, and a slow resolution could land after an unload.
  - `teardownPlugins` named the wrong plugin in its error log (reversed list, unreversed index).

  **Breaking**

  - The duplicate `ProviderRegistry` declared in `core/src/types.ts` is gone. It shadowed plugin-api's via
    `export type *`, so `import type { ProviderRegistry } from '@matatbread/matbot-core'` silently resolved
    to the adapter registry rather than the `ProviderConfig` map. Nothing imported it.
  - Core re-exports plugin-api's `/host` subpath in full, so hosts need no change for that move. Every
    branded error is now re-exported, including the previously-missing `readOnlyError`/`isReadOnlyError`.
  - The pre-Store flat-settings migration is dropped; an unrecognised settings document is treated as
    absent. Every `settings.get()` had been paying for the check.
  - `runSession` yields `TurnEvent` rather than `PipelineEvent` — a turn never emits the session-level
    `idle`.

## 0.3.10

### Patch Changes

- Tool media, per-provider round ceiling, and recovery from a truncated tool call.

  - `model-content` ToolEvent: a tool can hand the model an image, PDF or audio clip to look at. Pinned
    after the tool message it answers, carried for the rest of the turn, never persisted.
  - `document` converts natively for Anthropic (base64 PDF, decoded `text/*`) and Gemini (`inlineData`,
    which also covers audio) instead of degrading to a text placeholder in every adapter.
  - `ProviderConfig.maxRounds`: a per-profile ceiling on tool rounds per turn. Replaces the removed
    `ProviderConfig.fallback`, which was declared, parsed, and read by nothing.
  - A tool call cut off mid-arguments is answered with an error result instead of throwing, so the model
    self-corrects; a response cut short is recorded as an LLM-invisible `matbot-truncation` marker.
  - Fixes: `complete()` folds usage events instead of last-event-wins; `followup` no longer runs after an
    aborted or errored turn; a `toolcall` abort commits the turn; `FilesystemStore` escapes store ids
    that are not filename-safe rather than rejecting them; the anthropic adapter no longer emits adjacent
    same-role messages; openai-compat terminates a stream with exactly one `done`.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.9

## 0.3.8

### Patch Changes

- **`StoreQuery.immutable` is accepted by the query validator**, and `ItemChangeKind` /
  `RegistryChangeKind` are re-exported from `@matatbread/matbot-core` alongside `createNotifier`,
  `scopedNotifier` and `notifyingStore`, so a plugin linking only against core gets the renameable
  handles without reaching into `plugin-api`.

- Notification bus: one swappable service carrying every "something changed" fact.

  Five unrelated mechanisms used to tell a frontend something had changed — two core registry
  broadcasters, the SkillManager's own broadcaster, the file store's `fs.watch`, and a frontend-local
  busy broadcast — each with its own payload shape, its own SSE event name, and its own client
  plumbing in both transports. Adding a sixth kind meant editing four files, and several changes had
  no channel at all: a session created in one browser never appeared in another, a first share or an
  unshare never reached the sharee's list, and file deletions were structurally unrepresentable
  (`FileEvent` has no operation, and the filesystem watch drops them).

  - **`Notifier`** (`MatbotServices`, swappable, host boot default): `notify` / `subscribe` / `consume`
    over one `Notification` envelope. Within a plugin's `setup()` it is scoped, so published
    notifications carry that plugin's name.
  - **The envelope** discriminates on `kind` (the shape — `ItemChange`, `RegistryChange`, or an
    augmentation) _and_ carries attribution (`instance` / `plugin` / `source`) as separate fields, so a
    sink can filter on either or both. `principal` — whose data it is — stays distinct from
    attribution: it is what `WatchVisibility.visible` consumes. `kind` is **open at runtime**, so a
    `switch` over it must always have a `default`.
  - **A `kind` is `<package-name>#<InterfaceName>`** — `'@matatbread/matbot-plugin-api#ItemChange'`,
    `'@matatbread/matbot-plugin-api#RegistryChange'`. A `kind` is globally scoped and, unlike a type
    name, an importer cannot rename it out of a collision: two plugins picking the same bare word is an
    unfixable declaration-merge conflict in `Notifications`, and across a bridge a silent
    mis-narrowing. The package name — already unique — qualifies it, and names the package that
    _defines_ the shape, never the one emitting it (`plugin` is the emitter; four plugins emit
    `ItemChange`). `ItemChangeKind` / `RegistryChangeKind` are exported so consumers get a renameable
    handle back. An arm never declares `kind` itself: `NotificationBase` has no such field and
    `Notification` grafts each arm's `Notifications` key on, so the tag cannot disagree with the key it
    is registered under. `NotifyInput` rejects an unqualified key at the `notify` call, and
    `createNotifier` warns at runtime for producers TypeScript never saw (plain JS, a bridge).
  - **Identity, never value.** An `ItemChange` carries `namespace`/`id`/`operation`; `detail` is
    explicitly advisory. Consumers re-read through the store — an event is invalidation, not state. No
    persistence or replay: a sink re-queries on attach.
  - **New notifications**: every write to the `sessions` namespace (create, the turn pump's title
    derivation and persists, `session_action` rename/hide/unhide, `session_edit` fork/split) via a
    `notifyingStore` wrapper on that one store — the namespace has many writers, so one wrapper beats an
    explicit notify at each and cannot be forgotten by the next writer; `share` /
    `unshare` / `copy` landing in a profile (they mutate a partition's visible set without passing
    through a Store or the file watch, so nothing else could see them); a `background` job's captured
    output file completing.
  - **Distributed left open, not built**: an implementation registered over `Notifier` may forward
    off-box; `instance` is stamped on ingress and is the loop break. Nothing in core assumes one server.

  Two fixes the live list surfaced, both about an affordance that was previously unreachable:

  - **Deleting a shared-in item un-shares it.** The profiles backend now routes a `Store.delete` (and a
    `FileStore.delete`) of an item shared INTO the current partition through its own `unshare` path, instead
    of relying on the raw unlink happening to spare the owner's file: the shared-in cache is updated and the
    change is announced, where before both were stranded. No API changes — a delete is a delete to the
    caller, which may not have profiles loaded at all; only this layer can tell the two apart. The web
    session list's `×` on a shared-in session unshares rather than archiving it (an archive is a write, and
    raised `ReadOnlyError`); rename is withheld there for the same reason.
  - **An interactive prompt answered in another browser.** `prompt-resolved` is emitted on the session
    stream from the settle path every answer, cancel and abort funnels through, and the web UI retires a
    dialog on it. The UI's prompt case no longer _awaits_ the answer inside the turn's event loop: parking
    there stalled every later event of that turn in the other browsers — including the `prompt-resolved`
    that would have retired their dialog.

  The web frontend now consumes one `notification` SSE stream in place of `file-changed` /
  `skill-changed` / `tool-changed` / `plugin-changed`, with matching in-process wiring in the browser
  transport, and re-lists sessions live.

  **Breaking: `ToolRegistry.watch()` and `watchPlugins()` are removed**, along with
  `ToolRegistryEvent` and `PluginRegistryEvent`. Both registries were broadcasters over the same
  primitive the bus is, so keeping them was duplication rather than layering: they now publish a
  `RegistryChange` with `registry: 'tools' | 'plugins'` and consumers subscribe to the bus. `tools`
  notifications carry the registering plugin's name in the advisory `detail` (resolve the name for
  anything authoritative). Ported: `tool-router`, `tool-types`, the frontend's tool-resolve boot-grace
  wait, and the two bridges the frontend used to run. `SkillManager.watch()` went the same way.

  **Breaking: `FileStore.watch()` is removed**, with `FileEvent` and `WatchVisibility.watchFiles`.
  It existed to detect writes made outside matbot — but matbot writes `.data` and nothing else, and
  every in-process writer now announces itself, so no first-party feature depended on it. As a core
  interface it was actively misleading: only the filesystem store implemented it, sqlite re-broadcast
  its own writes (which the bus already carries), and Drive and OPFS returned a stream that yields
  nothing — making "this backend cannot watch" indistinguishable from "nothing has changed". Watching
  arbitrary filesystem activity is a plugin's job: it can watch whatever it likes and publish onto the
  bus, which any sink already understands. `GET /events/files/:ns/:name` goes with it (no first-party
  consumer); `/events` still carries every file notification. `WatchVisibility` keeps `visible()` — the
  part that was ever a contract rather than a transport.

  One channel deliberately remains outside the bus: `session-busy` is transient state replayed on
  connect, which the bus does not carry by design.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.7

## 0.3.6

### Patch Changes

- `instantiateProvider` resolves a provider's adapter by canonical plugin name before force-loading it.
  The factory registry is keyed by canonical name, but the specifier→name fallback only matched the exact
  literal string a plugin was loaded with, so two profiles naming one adapter by different specifiers (a
  yaml path and the package name) missed each other: whichever was used first registered the plugin, and
  the second force-loaded it again, threw "already registered", and surfaced as
  `provider "…" has no loadable adapter`. Stored profiles are still never rewritten.

## 0.3.5

### Patch Changes

- 3e662d0: Mid-turn steering: a submission arriving while a turn runs can now **interrupt** it.

  - **API gaps filled.** `SubmitOpenOpts` gains `mode: 'queue' | 'interrupt' | 'auto'` (default `queue`,
    backward-compatible). `interrupt` stops the running turn — keeping its committed partial work (the
    agentic loop already commits coherently on abort, so no dangling tool-call) — and runs the new
    message next with a "keep going, noting the above" nudge, rather than waiting for the turn boundary.
    The decision is made inside the runner, synchronously against the running state, so an interrupt can
    never land on a later turn.
  - **New optional service `SteeringPolicy`** (`MatbotServices`): under `mode: 'auto'`, its `classify`
    (regex / semantic / LLM — not assumed to be an LLM) decides queue vs interrupt; its `nudge` supplies
    the continuation nudge. Both members optional; absent ⇒ host defaults (`DEFAULT_STEERING_POLICY`,
    `interrupt`, and a built-in nudge).
  - **New `PipelineEvent` variant `steer`** — announces an interrupt so a frontend places the new bubble
    and reads the imminent `aborted` (reason `'steer'`) as a yield, not a dead-end.
  - **Interrupted tool results are reframed.** A tool that errors while the turn is aborted (a steer, a
    cancel) no longer leaks the raw abort reason (`"Error: steer"`) into its result — the runner records a
    neutral "interrupted before completion" message, so a steer's continuation turn reads a clear signal
    and doesn't reflexively re-run a side-effecting tool.
  - **Optional (frontend/web).** `POST /sessions/:id/submit` accepts `mode`, defaulting to `auto` — the
    web frontend opts into steering (interrupt-by-default with no policy registered). Other frontends are
    unchanged (runner default `queue`). The web UI renders the `steer` event as its user bubble live, and
    no longer re-renders the session from the interrupted turn's `aborted` snapshot (which lacked the
    not-yet-persisted steer message and wiped the live bubble until a manual refresh).

- Screen-phase classifier racing: a `screen` hook can race a verdict against the turn instead of gating the first token on it.

  - **API gaps filled.** `ScreenResult.deferred` — a new `DeferredScreen { claim(): DeferredCorrection | undefined }`
    lets a `screen` hook start expensive work (e.g. a classifier judging the user message) concurrently and
    return immediately, handing the runner a poll handle instead of blocking. The runner polls `claim()` —
    synchronously, never awaited — before each provider call, on every stream event, and just before commit;
    the first time it returns a correction, the runner **discards the uncommitted in-progress response and
    re-runs the loop with the correction folded in** (an in-situ redo: no store pop, no retraction marker).
    The mid-stream poll runs before each event is emitted, so a verdict faster than time-to-first-token is
    caught before any token reaches the frontend; a slower one aborts the in-flight provider request (a
    per-call `AbortController` linked to the turn signal) to stop backend generation. `claim()` is
    exactly-once, so a hook coordinates the in-situ path with its own post-commit fallback.
  - **`DeferredCorrection { ephemeral?, durable? }` and `FollowupResult.retractAndRerun.durable`.** A claimed
    correction — and a post-commit retract — can carry `durable` blocks folded onto the turn's user message
    (persisted, `origin: 'robo'`, carried live as a `robo-user` event) as well as, or instead of, `ephemeral`
    tail-fold blocks, so a durable-context correction keeps its persistence even when the verdict lands
    mid-turn or post-commit. `retractAndRerun.context` is correspondingly optional.
  - **Optional (triggers).** The user-phase classifier now races the turn instead of blocking the first token:
    `screen` kicks off classify+dispatch concurrently and hands the runner a `DeferredScreen`, and the
    correction is delivered on whichever path wins — a pre-first-token grace inject, the runner's in-situ
    restart, or the post-commit `followup` retract (`contextual` fires fold durably, `ephemeral` fires
    tail-fold, on all three). This removes the classifier round-trip from the critical path of the ~90% of
    turns where nothing fires. New `classifierGraceMs` setting (default `0`): `0` is a pure race (no added
    latency); a positive value holds the first token up to that long so a fast classifier injects cleanly
    before generation — one knob spanning fully-responsive to fully-clean. Raced verdicts are traced by a
    `user-insitu-fired` (clean path) or `user-retract-fired` (post-commit) marker.

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5

## 0.3.4

### Patch Changes

- c3a1b00: New branded `ReadOnlyError` (`readOnlyError()` factory + `isReadOnlyError()` guard, alongside the other
  brand-based typed errors) for a `Store` write rejected because the current principal does not own the
  item — e.g. a session shared read-only from another profile's partition.

  The turn pump now catches it around the persist-at-turn-start write in `SessionRunner`: a read-only
  rejection is surfaced as a per-turn `error` event and the submission is dropped, instead of escaping the
  detached pump and crashing the host. Any other write failure stays fatal as before. Detection uses the
  brand guard, never `instanceof`, so it holds across a skewed/duplicated plugin-api install.

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4

## 0.3.3

### Patch Changes

- Native Google Gemini provider + provider-agnostic round-trip metadata.

  - New `@matatbread/matbot-provider-google`: one `module:`, two wire formats chosen by endpoint path — native `generateContent` adapter, or the openai-compat adapter in `gemini` mode. Thought-signature round-trip, foreign/unsignable tool calls degraded to text context notes (not elided), and tool schemas sanitized to Gemini's strict OpenAPI subset.
  - `plugin-api`/`core`: replaced the tool-call `signature?: string` with an augmentable `meta?: ProviderMeta`. Providers declare their own namespaced slice from their own module, so core carries round-trip metadata opaquely and never changes when a provider adds its own.
  - `openai-compat`: opt-in `gemini` mode (thought-signature round-trip via `extra_content.google.thought_signature` + foreign-call degradation); homes the `ProviderMeta.google` augmentation.
  - `tool-router`: order the working set by adoption (first-seen) so it grows append-only, keeping the tools prefix byte-stable for prompt caching.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2

## 0.2.9

### Patch Changes

- frontend/telegram: fix a boot crash (`No provider registered for module "…". Available: none`) that unloaded the plugin at startup. It eagerly built a provider adapter in `setup()` via the removed `resolveProviderFactory(config.module)`, but with the pre-scan disabled no factory is registered yet. The frontend now holds only the active provider name and lets the runner resolve the adapter per turn via `complete()` → `instantiateProvider`. Also removes the dead `resolveProviderFactory` export from core.
  - @matatbread/matbot-plugin-api@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8

## 0.2.7

### Patch Changes

- Release 0.2.7
  - @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6

## 0.2.4

### Patch Changes

- Release: web_user_environment + compact_sessions tools, triggers reworked to fire tools with the user/agent × ephemeral/durable orthogonality, quiescent-edge registry application, google-drive storage backend, durable screen context / retractAndRerun, persisted token usage, plus the npm-publishing restructure and assorted fixes. See CHANGELOG.md.
  - @matatbread/matbot-plugin-api@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.7

## 0.1.6

### Patch Changes

- b40c2ec: fix(core/config): tolerate empty `plugins:` / `providers:` sections

  A bare `plugins:` (or `providers:`) key with no entries parses to YAML `null`,
  which the loader rejected with `"plugins" must be a sequence (list)`. This is the
  state `plugin remove` leaves behind when it deletes the last list item, so a config
  that had every plugin removed failed to boot. An empty/null section now reads as
  empty.

  - @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.1
