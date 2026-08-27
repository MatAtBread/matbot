# @matatbread/matbot-cli

## 0.4.11

### Patch Changes

- @matatbread/matbot-core@0.4.11

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

- Updated dependencies
- Updated dependencies
  - @matatbread/matbot-core@0.4.10

## 0.4.9

### Patch Changes

- Updated dependencies [f6d546d]
  - @matatbread/matbot-core@0.4.9

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
  - @matatbread/matbot-core@0.4.8

## 0.4.7

### Patch Changes

- @matatbread/matbot-core@0.4.7
- @matatbread/matbot-files-node@0.4.7
- @matatbread/matbot-provenance@0.4.7
- @matatbread/matbot-provider-anthropic@0.4.7
- @matatbread/matbot-provider-chatjimmy@0.4.7
- @matatbread/matbot-provider-customer-services@0.4.7
- @matatbread/matbot-provider-google@0.4.7
- @matatbread/matbot-provider-openai-compat@0.4.7
- @matatbread/matbot-storage-filesystem@0.4.7
- @matatbread/matbot-tool-plugin@0.4.7

## 0.4.6

### Patch Changes

- @matatbread/matbot-core@0.4.6
- @matatbread/matbot-files-node@0.4.6
- @matatbread/matbot-provenance@0.4.6
- @matatbread/matbot-provider-anthropic@0.4.6
- @matatbread/matbot-provider-chatjimmy@0.4.6
- @matatbread/matbot-provider-customer-services@0.4.6
- @matatbread/matbot-provider-google@0.4.6
- @matatbread/matbot-provider-openai-compat@0.4.6
- @matatbread/matbot-storage-filesystem@0.4.6
- @matatbread/matbot-tool-plugin@0.4.6

## 0.4.5

### Patch Changes

- The first-run setup wizard stores its API key through the `Vault` instead of writing `.env` itself.

  Answering the "API key" prompt with the name of a key the `.env` already held appended a synthetic
  `MATBOT_API_KEY_<PROVIDER>` whose value was that key's name, and the typed string was handed to the
  provider verbatim for that first run. Nothing at the prompt can tell a secret from the name of one,
  which is what `createSecret` is for — naming an existing key now references it, a value already
  stored under another name dedups to that name, and only a new secret mints
  `MATBOT_API_KEY_<PROVIDER>`. A blank answer writes no `credentials:` block rather than an empty
  `.env` line, since an empty value is the vault's removal signal.

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
- Updated dependencies [e65e2a3]
  - @matatbread/matbot-core@0.4.5
  - @matatbread/matbot-storage-filesystem@0.4.5
  - @matatbread/matbot-files-node@0.4.5
  - @matatbread/matbot-provenance@0.4.5
  - @matatbread/matbot-provider-anthropic@0.4.5
  - @matatbread/matbot-provider-chatjimmy@0.4.5
  - @matatbread/matbot-provider-customer-services@0.4.5
  - @matatbread/matbot-provider-google@0.4.5
  - @matatbread/matbot-provider-openai-compat@0.4.5
  - @matatbread/matbot-tool-plugin@0.4.5

## 0.4.4

### Patch Changes

- 6fb2706: Warn once when a configured storage backend is discarded by another plugin's.

  Exactly one `StorageBackend` is ever active: the boot pre-scan opens the first configured plugin that
  offers one and stops, and a plugin registering one later displaces it at the quiescent edge. Both are
  supported operations, and neither said anything — but the loser has usually already created its file,
  so configuring two storage plugins left an orphaned database and every write going somewhere else,
  presenting as "my backend is configured and does nothing".

  The concrete case is `storage-profiles` alongside `storage-sqlite`. Profiles composes the filesystem
  primitive directly rather than wrapping the active backend (partitioning is medium-specific — nested
  directories here, a partition column or row-level policies elsewhere — so there is no general wrapper),
  which means it cannot layer over SQLite and instead replaces it, whichever order they are listed in.
  The host now says so once, naming the displaced plugin, at the moment it stops being true.

  The rationale is written down in `CLAUDE.md` and the profiles README, including why the shared
  `ProfileDirectory` surface does not need hoisting into `plugin-api`: consumers duck-type the _active_
  backend on method presence, so any backend exposing that shape is already picked up by the existing
  tools with no import and no API change.

- @matatbread/matbot-core@0.4.4
- @matatbread/matbot-files-node@0.4.4
- @matatbread/matbot-provenance@0.4.4
- @matatbread/matbot-provider-anthropic@0.4.4
- @matatbread/matbot-provider-chatjimmy@0.4.4
- @matatbread/matbot-provider-customer-services@0.4.4
- @matatbread/matbot-provider-google@0.4.4
- @matatbread/matbot-provider-openai-compat@0.4.4
- @matatbread/matbot-storage-filesystem@0.4.4
- @matatbread/matbot-tool-plugin@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-core@0.4.3
- @matatbread/matbot-files-node@0.4.3
- @matatbread/matbot-provenance@0.4.3
- @matatbread/matbot-provider-anthropic@0.4.3
- @matatbread/matbot-provider-chatjimmy@0.4.3
- @matatbread/matbot-provider-customer-services@0.4.3
- @matatbread/matbot-provider-google@0.4.3
- @matatbread/matbot-provider-openai-compat@0.4.3
- @matatbread/matbot-storage-filesystem@0.4.3
- @matatbread/matbot-tool-plugin@0.4.3

## 0.4.2

### Patch Changes

- `--dump-tools` also emits the unfolded wire contract.

  Each entry gains `wireContract: { params, result }` alongside the description it was already folded into, so a consumer comparing a tool's two authored descriptions of its inputs need not regex the contract back out of the prose. Additive; existing consumers are unaffected.

- Updated dependencies
  - @matatbread/matbot-core@0.4.2
  - @matatbread/matbot-tool-plugin@0.4.2
  - @matatbread/matbot-files-node@0.4.2
  - @matatbread/matbot-provenance@0.4.2
  - @matatbread/matbot-provider-anthropic@0.4.2
  - @matatbread/matbot-provider-chatjimmy@0.4.2
  - @matatbread/matbot-provider-customer-services@0.4.2
  - @matatbread/matbot-provider-google@0.4.2
  - @matatbread/matbot-provider-openai-compat@0.4.2
  - @matatbread/matbot-storage-filesystem@0.4.2

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
  - @matatbread/matbot-core@0.3.10
  - @matatbread/matbot-provider-anthropic@0.3.10
  - @matatbread/matbot-provider-google@0.3.10
  - @matatbread/matbot-provider-openai-compat@0.3.10
  - @matatbread/matbot-storage-filesystem@0.3.10
  - @matatbread/matbot-tool-plugin@0.3.10
  - @matatbread/matbot-provenance@0.3.10
  - @matatbread/matbot-files-node@0.3.10
  - @matatbread/matbot-provider-chatjimmy@0.3.10
  - @matatbread/matbot-provider-customer-services@0.3.10

## 0.3.9

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @matatbread/matbot-provider-anthropic@0.3.9
  - @matatbread/matbot-provenance@0.3.9
  - @matatbread/matbot-tool-plugin@0.3.9
  - @matatbread/matbot-core@0.3.9
  - @matatbread/matbot-files-node@0.3.9
  - @matatbread/matbot-provider-chatjimmy@0.3.9
  - @matatbread/matbot-provider-customer-services@0.3.9
  - @matatbread/matbot-provider-google@0.3.9
  - @matatbread/matbot-provider-openai-compat@0.3.9
  - @matatbread/matbot-storage-filesystem@0.3.9

## 0.3.8

### Patch Changes

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
  - @matatbread/matbot-core@0.3.8
  - @matatbread/matbot-files-node@0.3.8
  - @matatbread/matbot-provider-anthropic@0.3.8
  - @matatbread/matbot-provider-chatjimmy@0.3.8
  - @matatbread/matbot-provider-customer-services@0.3.8
  - @matatbread/matbot-provider-google@0.3.8
  - @matatbread/matbot-provider-openai-compat@0.3.8
  - @matatbread/matbot-storage-filesystem@0.3.8
  - @matatbread/matbot-tool-plugin@0.3.8

## 0.3.7

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-provider-anthropic@0.3.7
  - @matatbread/matbot-core@0.3.7
  - @matatbread/matbot-files-node@0.3.7
  - @matatbread/matbot-provider-chatjimmy@0.3.7
  - @matatbread/matbot-provider-customer-services@0.3.7
  - @matatbread/matbot-provider-google@0.3.7
  - @matatbread/matbot-provider-openai-compat@0.3.7
  - @matatbread/matbot-storage-filesystem@0.3.7
  - @matatbread/matbot-tool-plugin@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-files-node@0.3.5
  - @matatbread/matbot-provider-anthropic@0.3.5
  - @matatbread/matbot-provider-customer-services@0.3.5
  - @matatbread/matbot-provider-google@0.3.5
  - @matatbread/matbot-provider-openai-compat@0.3.5
  - @matatbread/matbot-storage-filesystem@0.3.5
  - @matatbread/matbot-tool-plugin@0.3.5

- 4276c38: **Optional (providers/chatjimmy).** The ChatJimmy adapter is no longer `private` — it publishes as
  `@matatbread/matbot-provider-chatjimmy` and is a dependency of the CLI, so it appears in the first-run
  setup wizard's provider list (option 5) and resolves by bare package name from an installed matbot as
  well as a source checkout. A hosted llama endpoint: keyless, non-streaming (one `text-delta` per turn),
  text-only and no tool-calling — useful as a low-latency comparison point rather than a
  general-purpose provider.
- Updated dependencies [4276c38]
  - @matatbread/matbot-provider-chatjimmy@0.3.5
  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-files-node@0.3.5
  - @matatbread/matbot-provider-anthropic@0.3.5
  - @matatbread/matbot-provider-customer-services@0.3.5
  - @matatbread/matbot-provider-google@0.3.5
  - @matatbread/matbot-provider-openai-compat@0.3.5
  - @matatbread/matbot-storage-filesystem@0.3.5
  - @matatbread/matbot-tool-plugin@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [36fee95]
- Updated dependencies [c3a1b00]
  - @matatbread/matbot-files-node@0.3.4
  - @matatbread/matbot-core@0.3.4
  - @matatbread/matbot-provider-anthropic@0.3.4
  - @matatbread/matbot-provider-customer-services@0.3.4
  - @matatbread/matbot-provider-google@0.3.4
  - @matatbread/matbot-provider-openai-compat@0.3.4
  - @matatbread/matbot-storage-filesystem@0.3.4
  - @matatbread/matbot-tool-plugin@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.3.3
  - @matatbread/matbot-provider-google@0.3.3
  - @matatbread/matbot-provider-openai-compat@0.3.3
  - @matatbread/matbot-files-node@0.3.3
  - @matatbread/matbot-provider-anthropic@0.3.3
  - @matatbread/matbot-provider-customer-services@0.3.3
  - @matatbread/matbot-storage-filesystem@0.3.3
  - @matatbread/matbot-tool-plugin@0.3.3

## 0.3.2

### Patch Changes

- @matatbread/matbot-core@0.3.2
- @matatbread/matbot-files-node@0.3.2
- @matatbread/matbot-provider-anthropic@0.3.2
- @matatbread/matbot-provider-customer-services@0.3.2
- @matatbread/matbot-provider-openai-compat@0.3.2
- @matatbread/matbot-storage-filesystem@0.3.2
- @matatbread/matbot-tool-plugin@0.3.2

## 0.2.9

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.9
  - @matatbread/matbot-files-node@0.2.9
  - @matatbread/matbot-provider-anthropic@0.2.9
  - @matatbread/matbot-provider-customer-services@0.2.9
  - @matatbread/matbot-provider-openai-compat@0.2.9
  - @matatbread/matbot-storage-filesystem@0.2.9
  - @matatbread/matbot-tool-plugin@0.2.9

## 0.2.8

### Patch Changes

- @matatbread/matbot-core@0.2.8
- @matatbread/matbot-files-node@0.2.8
- @matatbread/matbot-provider-anthropic@0.2.8
- @matatbread/matbot-provider-customer-services@0.2.8
- @matatbread/matbot-provider-openai-compat@0.2.8
- @matatbread/matbot-storage-filesystem@0.2.8
- @matatbread/matbot-tool-plugin@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.7
  - @matatbread/matbot-files-node@0.2.7
  - @matatbread/matbot-provider-anthropic@0.2.7
  - @matatbread/matbot-provider-customer-services@0.2.7
  - @matatbread/matbot-provider-openai-compat@0.2.7
  - @matatbread/matbot-storage-filesystem@0.2.7
  - @matatbread/matbot-tool-plugin@0.2.7

## 0.2.6

### Patch Changes

- @matatbread/matbot-core@0.2.6
- @matatbread/matbot-files-node@0.2.6
- @matatbread/matbot-provider-anthropic@0.2.6
- @matatbread/matbot-provider-customer-services@0.2.6
- @matatbread/matbot-provider-openai-compat@0.2.6
- @matatbread/matbot-storage-filesystem@0.2.6
- @matatbread/matbot-tool-plugin@0.2.6

## 0.2.4

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.4
  - @matatbread/matbot-files-node@0.2.4
  - @matatbread/matbot-provider-anthropic@0.2.4
  - @matatbread/matbot-provider-customer-services@0.2.4
  - @matatbread/matbot-provider-openai-compat@0.2.4
  - @matatbread/matbot-storage-filesystem@0.2.4
  - @matatbread/matbot-tool-plugin@0.2.4

## 0.2.3

### Patch Changes

- 3349bbc: tool-plugin: give a readable error when a github/URL-fetched plugin has an unresolved dependency, and
  document which sources resolve dependency graphs. A raw source-fetch installs one plugin's own files,
  not its dependency graph, so a plugin with a runtime dependency on another package (cognition →
  @matatbread/matbot-tool-store) fails to activate with an opaque ERR_MODULE_NOT_FOUND — which sent the
  model hunting for npm name variations. The `plugin` add flow now names the missing package and states
  the remedy (install the dependency too; from npm for first-party packages, where its own deps resolve),
  explicitly telling the model not to retry name variations; the entry is left in config so it activates
  once the dependency is present. The `plugin` tool description and the `Classified` source type now spell
  out dependency resolution per source: npm/.tgz/git resolve the full tree; local inherits the surrounding
  node_modules; raw github/HTTP fetches only the plugin's own files (deps must be provided separately).
  - @matatbread/matbot-core@0.2.3
  - @matatbread/matbot-files-node@0.2.3
  - @matatbread/matbot-provider-anthropic@0.2.3
  - @matatbread/matbot-provider-customer-services@0.2.3
  - @matatbread/matbot-provider-openai-compat@0.2.3
  - @matatbread/matbot-storage-filesystem@0.2.3
  - @matatbread/matbot-tool-plugin@0.2.3

## 0.2.2

### Patch Changes

- 52faee7: tool-plugin: github/http-fetched plugins now resolve each other by canonical package name. A remote
  plugin is registered in the `.plugins/` symlink farm under its own `package.json` name when fetched,
  so a sibling that imports it (`@matatbread/matbot-skills` from skills-node, `@matatbread/matbot-tool-store`
  from cognition) resolves to the fetched copy — the package name is the canonical identity, independent
  of the source it came from. Previously only host-installed packages were bridged, so inter-dependent
  plugins installed from github failed with `ERR_MODULE_NOT_FOUND`. The host singletons (plugin-api/core)
  are never self-registered, so the singleton boundary is preserved.

  Also: the `plugin` tool now refuses to "install" a host runtime package (`@matatbread/matbot-plugin-api`,
  `@matatbread/matbot-core`, with or without a version suffix) as a plugin, instead of letting it land in
  the config as a bogus, unloadable entry.

  - @matatbread/matbot-core@0.2.2
  - @matatbread/matbot-files-node@0.2.2
  - @matatbread/matbot-provider-anthropic@0.2.2
  - @matatbread/matbot-provider-customer-services@0.2.2
  - @matatbread/matbot-provider-openai-compat@0.2.2
  - @matatbread/matbot-storage-filesystem@0.2.2
  - @matatbread/matbot-tool-plugin@0.2.2

## 0.2.1

### Patch Changes

- 2578f79: Harden the host-shared singletons (plugin-api/core) against duplication in skewed installs, so a
  second physical copy is benign instead of corrupting. Two changes, per an audit of all module-level
  state (see new `docs/duplicate-singletons.md`):

  - **State-shaped singletons now live on `globalThis`.** New `globalSlot()` helper anchors shared
    state under one `Symbol.for` key; the context-switch quiescers/depth/flushing state (reachable by a
    storage plugin) moves there, joining the principal carrier. Duplicate copies share one object
    rather than splitting.

  - **Typed errors are now duck-typed, not classes** (BREAKING for code using them). `MissingSecretError`,
    `IncompatibleRuntimeError`, `NotAPluginError`, `PromptCancelledError` are now plain `Error`s carrying
    a `matbot` brand string. Construct with the `xError()` factory and detect with the `isXError()` guard
    instead of `new XError()` / `instanceof XError` — the brand is identity-independent, so a guard works
    across module copies (where `instanceof` silently returned `false`). The `XError` names remain as
    **types** for annotations and field access. `StoreQueryError` is unchanged (not reached by
    `instanceof` across the boundary).

- 8139163: frontend-web: don't crash the process when an SSE write hits a dead socket. Tearing the server down
  mid-stream (e.g. unloading the frontend-web plugin while a session's `/events` stream is open) makes
  a pending `res.write` emit an asynchronous `'error'` on a later tick — which escapes the request
  handler's try/catch and, with no listener, becomes an unhandled `'error'` event that exits the
  process. The handler now attaches a no-op `'error'` listener to every request/response, so a
  dead-socket write is absorbed (the SSE loop already breaks on `!res.writable`).
  - @matatbread/matbot-core@0.2.1
  - @matatbread/matbot-files-node@0.2.1
  - @matatbread/matbot-provider-anthropic@0.2.1
  - @matatbread/matbot-provider-customer-services@0.2.1
  - @matatbread/matbot-provider-openai-compat@0.2.1
  - @matatbread/matbot-storage-filesystem@0.2.1
  - @matatbread/matbot-tool-plugin@0.2.1

## 0.2.0

### Minor Changes

- ede1b7b: feat(cli): version banner + `--version` flag surfacing resolved singleton versions

  The CLI now prints `matbot vX (core Y, plugin-api Z)` at boot and via `matbot --version`
  (`-v`). The core/plugin-api versions are the ones actually _resolved_ at runtime
  (plugin-api through core, the instance the principal carrier lives in), so a duplicated /
  version-skewed install shows up directly — and prints an explicit "version skew" warning
  with the reinstall remedy instead of failing obscurely later.

- d550b6a: cognition/dream-time: drain the whole backlog per pass instead of one fact.

  Each `dream_time` pass already ranks the entire `remembered_facts` backlog against every skill in a
  single call, but the old pipeline acted only on the oldest fact (plus cluster-mates sharing its
  skill) and threw the rest of the scores away — and only the oldest fact's `weak`/`none` disposition
  was recorded, so every other fact was re-ranked from scratch on every pass. That made throughput one
  fact per pass at `O(facts × skills)` cost each.

  `runOnce` now spends the one ranking on all facts: strong facts are grouped by chosen skill and
  merged up to a per-pass budget, weak facts are all deferred, and dead `none` facts are all retired —
  in the same pass. A per-fact merge failure quarantines just the culprit and the pass carries on with
  the other skills (previously it aborted the whole pass). Partial cluster progress is now committed
  rather than discarded on failure.

  New `cognition_config` tunables: `maxMergesPerPass` (default 20; cap on facts merged across all
  skills per pass) and `maxEnrichmentsPerPass` (default 10; cap on `none` facts given an enriched
  second look, the rest deferred not retired). `maxClusterSize` is now the per-skill cap. `DreamRun`
  records gain `deferred`/`retired`/`quarantined` counts and an `errors` list; `unassignedRemaining`
  now means immediately-actionable (over-budget strong) facts.

### Patch Changes

- d550b6a: Add npm `keywords` to every published package. A shared `matbot` anchor on all of
  them plus a role tag by location (`matbot-plugin-api`, `matbot-core`, `matbot-app`,
  `matbot-plugin`, and `matbot-provider`/`matbot-frontend`/`matbot-storage`). This makes
  the family discoverable via npmjs keyword search (`keywords:matbot`,
  `keywords:matbot,matbot-provider`) rather than relying on the lagging text/org index.
  - @matatbread/matbot-core@0.2.0
  - @matatbread/matbot-files-node@0.2.0
  - @matatbread/matbot-provider-anthropic@0.2.0
  - @matatbread/matbot-provider-customer-services@0.2.0
  - @matatbread/matbot-provider-openai-compat@0.2.0
  - @matatbread/matbot-storage-filesystem@0.2.0
  - @matatbread/matbot-tool-plugin@0.2.0

## 0.1.8

### Patch Changes

- @matatbread/matbot-core@0.1.8
- @matatbread/matbot-files-node@0.1.8
- @matatbread/matbot-provider-anthropic@0.1.8
- @matatbread/matbot-provider-customer-services@0.1.8
- @matatbread/matbot-provider-openai-compat@0.1.8
- @matatbread/matbot-storage-filesystem@0.1.8
- @matatbread/matbot-tool-plugin@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-core@0.1.7
- @matatbread/matbot-files-node@0.1.7
- @matatbread/matbot-provider-anthropic@0.1.7
- @matatbread/matbot-provider-customer-services@0.1.7
- @matatbread/matbot-provider-openai-compat@0.1.7
- @matatbread/matbot-storage-filesystem@0.1.7
- @matatbread/matbot-tool-plugin@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [b40c2ec]
  - @matatbread/matbot-core@0.1.6
  - @matatbread/matbot-files-node@0.1.6
  - @matatbread/matbot-provider-anthropic@0.1.6
  - @matatbread/matbot-provider-openai-compat@0.1.6
  - @matatbread/matbot-storage-filesystem@0.1.6
  - @matatbread/matbot-tool-plugin@0.1.6
  - @matatbread/matbot-provider-customer-services@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [84397a6]
  - @matatbread/matbot-tool-plugin@0.1.5
  - @matatbread/matbot-core@0.1.5
  - @matatbread/matbot-files-node@0.1.5
  - @matatbread/matbot-provider-anthropic@0.1.5
  - @matatbread/matbot-provider-customer-services@0.1.5
  - @matatbread/matbot-provider-openai-compat@0.1.5
  - @matatbread/matbot-storage-filesystem@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [7ea2a82]
  - @matatbread/matbot-tool-plugin@0.1.4
  - @matatbread/matbot-core@0.1.4
  - @matatbread/matbot-files-node@0.1.4
  - @matatbread/matbot-provider-anthropic@0.1.4
  - @matatbread/matbot-provider-customer-services@0.1.4
  - @matatbread/matbot-provider-openai-compat@0.1.4
  - @matatbread/matbot-storage-filesystem@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [fe27c9f]
  - @matatbread/matbot-tool-plugin@0.1.3
  - @matatbread/matbot-core@0.1.3
  - @matatbread/matbot-files-node@0.1.3
  - @matatbread/matbot-provider-anthropic@0.1.3
  - @matatbread/matbot-provider-customer-services@0.1.3
  - @matatbread/matbot-provider-openai-compat@0.1.3
  - @matatbread/matbot-storage-filesystem@0.1.3

## 0.1.2

### Patch Changes

- f9f193c: Fix first-run setup on an npm install. The CLI now bundles the provider adapters
  (anthropic, openai-compat, customer-services) as dependencies, discovers them via
  module resolution instead of a monorepo-only directory scan, and writes the
  provider's package name as `module:` in matbot.yaml (resolves in both an install
  and the workspace). Previously `matbot` aborted with "No provider packages found".
- 55ab48d: Suppress the experimental `stripTypeScriptTypes` warning that the loader otherwise
  prints on every plugin load. Only that one warning is filtered; all others pass through.
  - @matatbread/matbot-core@0.1.2
  - @matatbread/matbot-files-node@0.1.2
  - @matatbread/matbot-provider-anthropic@0.1.2
  - @matatbread/matbot-provider-customer-services@0.1.2
  - @matatbread/matbot-provider-openai-compat@0.1.2
  - @matatbread/matbot-storage-filesystem@0.1.2
  - @matatbread/matbot-tool-plugin@0.1.2

## 0.1.1

### Patch Changes

- 0f863be: Strip TypeScript types in the CLI loader so published packages run. Node's native
  type stripper refuses `.ts` files under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which broke `npx matbot` from an
  npm install. `ts-hooks.js` now strips types itself in a `load` hook (via
  `module.stripTypeScriptTypes`), so installed raw-`.ts` packages load the same as
  workspace ones.
  - @matatbread/matbot-core@0.1.1
  - @matatbread/matbot-files-node@0.1.1
  - @matatbread/matbot-storage-filesystem@0.1.1
  - @matatbread/matbot-tool-plugin@0.1.1
