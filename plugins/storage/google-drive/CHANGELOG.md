# @matatbread/matbot-storage-google-drive

## 0.4.4

### Patch Changes

- @matatbread/matbot-core@0.4.4
- @matatbread/matbot-plugin-api@0.4.4
- @matatbread/matbot-browser@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-core@0.4.3
- @matatbread/matbot-plugin-api@0.4.3
- @matatbread/matbot-browser@0.4.3

## 0.4.2

### Patch Changes

- One shared contract for the `plugin` and `provider` tools, and named result shapes that can be augmented.

  Both tools have a node and a browser implementation, and each declared its own `ToolContracts` arm. A registry key is registered by declaration merging, so two declarations are legal only while identical — these were not, and `buildMatbotToolsDts` never read the Program's diagnostics, so one won on file order and its shape was emitted as the contract. In any tree containing `plugins/`, the browser shapes won, and node's generated code was graded against them: the check loop rejected `providers[].hasCredentials` (what node returns) and accepted `providers[].hasKey` (`undefined` at runtime).

  Both now declare `PluginToolContract` / `ProviderToolContract` from plugin-api. Node's names win, so the browser tool renames `hasKey` → `hasCredentials`, `adapter` → `module`, `ProviderRow` → `ProviderSummary`, and takes `ModelParameters` for `parameters`. `FailedPlugin` moves from core to plugin-api (still re-exported from core). Result shapes are named, exported interfaces, so a host overriding a builtin tool can augment them instead of being unable to describe its own return.

  Duplicate registry declarations are now reported rather than silently resolved.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2
  - @matatbread/matbot-core@0.4.2
  - @matatbread/matbot-browser@0.4.2

## 0.3.10

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10
  - @matatbread/matbot-core@0.3.10
  - @matatbread/matbot-browser@0.3.10

## 0.3.9

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-browser@0.3.9
  - @matatbread/matbot-core@0.3.9
  - @matatbread/matbot-plugin-api@0.3.9

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
  - @matatbread/matbot-plugin-api@0.3.8
  - @matatbread/matbot-core@0.3.8
  - @matatbread/matbot-browser@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-core@0.3.7
- @matatbread/matbot-plugin-api@0.3.7
- @matatbread/matbot-browser@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-browser@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-browser@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4
  - @matatbread/matbot-core@0.3.4
  - @matatbread/matbot-browser@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3
  - @matatbread/matbot-core@0.3.3
  - @matatbread/matbot-browser@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2
  - @matatbread/matbot-core@0.3.2
  - @matatbread/matbot-browser@0.3.2

## 0.2.9

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.9
  - @matatbread/matbot-plugin-api@0.2.9
  - @matatbread/matbot-browser@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8
  - @matatbread/matbot-core@0.2.8
  - @matatbread/matbot-browser@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.7
  - @matatbread/matbot-plugin-api@0.2.7
  - @matatbread/matbot-browser@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6
  - @matatbread/matbot-core@0.2.6
  - @matatbread/matbot-browser@0.2.6

## 0.2.4

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.4
  - @matatbread/matbot-plugin-api@0.2.4
  - @matatbread/matbot-browser@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-core@0.2.3
- @matatbread/matbot-plugin-api@0.2.3
- @matatbread/matbot-browser@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-core@0.2.2
- @matatbread/matbot-plugin-api@0.2.2
- @matatbread/matbot-browser@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-core@0.2.1
- @matatbread/matbot-plugin-api@0.2.1
- @matatbread/matbot-browser@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-core@0.2.0
- @matatbread/matbot-plugin-api@0.2.0
- @matatbread/matbot-browser@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8
  - @matatbread/matbot-core@0.1.8
  - @matatbread/matbot-browser@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-core@0.1.7
- @matatbread/matbot-plugin-api@0.1.7
- @matatbread/matbot-browser@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [b40c2ec]
  - @matatbread/matbot-core@0.1.6
  - @matatbread/matbot-browser@0.1.6
  - @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-core@0.1.5
- @matatbread/matbot-plugin-api@0.1.5
- @matatbread/matbot-browser@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-core@0.1.4
- @matatbread/matbot-plugin-api@0.1.4
- @matatbread/matbot-browser@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-core@0.1.3
- @matatbread/matbot-plugin-api@0.1.3
- @matatbread/matbot-browser@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-core@0.1.2
- @matatbread/matbot-plugin-api@0.1.2
- @matatbread/matbot-browser@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-core@0.1.1
- @matatbread/matbot-plugin-api@0.1.1
- @matatbread/matbot-browser@0.1.1
