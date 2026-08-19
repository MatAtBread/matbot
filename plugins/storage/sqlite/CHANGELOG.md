# @matatbread/matbot-storage-sqlite

## 0.4.7

### Patch Changes

- @matatbread/matbot-core@0.4.7
- @matatbread/matbot-plugin-api@0.4.7

## 0.4.6

### Patch Changes

- @matatbread/matbot-core@0.4.6
- @matatbread/matbot-plugin-api@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
- Updated dependencies [e65e2a3]
  - @matatbread/matbot-plugin-api@0.4.5
  - @matatbread/matbot-core@0.4.5

## 0.4.4

### Patch Changes

- b62a000: A namespace is now stored under its own name, and validated where untrusted ones arrive.

  **SQLite no longer mangles table names.** A namespace became a table by replacing every character
  outside `[A-Za-z0-9]` with `_`, so `A-B` and `A_B` both produced `A_B_store` and **silently shared one
  table** — two stores, one set of rows, no error. The derivation bought nothing: every statement already
  wrapped the table in double quotes, and a quoted identifier holds any namespace at all (punctuation,
  spaces, unicode, a `"` doubled per SQL). It is simply removed, so the mapping is exact in both
  directions.

  A database written under the old naming keeps its data: the first time a namespace is opened, a table
  under the legacy mangled name is `ALTER TABLE … RENAME`d to the exact one. That is done at
  `createStore` because it is the only moment the namespace and its table are both known — the mangling
  cannot be inverted, so nothing scanning `sqlite_master` alone could pair them. It fires only when the
  exact table is absent and the legacy one present; a database holding both is one where two namespaces
  were already sharing a table, and the rows follow whichever opens first, there being no record of who
  wrote them.

  This also removes the `namespace_registry` table added earlier in this release: with names exact,
  `namespaces()` reads `sqlite_master` and strips the suffix, with nothing to keep in step.

  **`store_action` validates the namespace** (`create` and `expose`) against
  `[A-Za-z0-9][A-Za-z0-9_-]*`, max 64. The namespace is LLM-supplied and is not an opaque key: the
  filesystem backend makes it a directory name **verbatim** — document ids are percent-encoded,
  namespaces never were — so `../evil` or `a/b` wrote outside `.data` entirely. Checking at the one
  boundary untrusted names arrive is what lets each backend keep using it directly. The set admits every
  namespace matbot itself uses, `profile-registry` and `plugin-manifest` included.

  **`create` now also refuses a namespace already present in the backend**, compared
  case-insensitively — the first consumer of `StorageBackend.namespaces?()`. It catches what the meta
  store structurally cannot: a namespace owned by a plugin rather than created here, so `store_action`
  can no longer create a store over `sessions`. Case-insensitively because a namespace is a directory,
  and `Sessions` and `sessions` are one directory on macOS and Windows. Backends that cannot enumerate
  contribute nothing and an empty namespace is not reported, so it is one check among several rather
  than an oracle.

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

- The SQLite backend compiles `StoreQuery` to SQL instead of loading the namespace into memory.

  `StoreQuery` is specified as a translation target rather than an engine, and until now nothing in the
  repo demonstrated the translation: every backend delegated to the in-memory reference, so the claim
  that the grammar "maps to a real query language" rested on the shape of the AST alone. `query()` now
  compiles the filter to a `WHERE` clause, the sort to `ORDER BY`, and the page to `LIMIT`/`OFFSET`,
  with `limit: 0` becoming `SELECT COUNT(*)` — so a large namespace is no longer read, parsed and
  sorted in full to answer a filtered query, and a count materialises nothing at all.

  Documents are stored as JSON text, so a field becomes `json_extract(doc, <path>)` and its type
  `json_type(doc, <path>)`. That pair carries the translation: `json_type` returns NULL for an absent
  path and `'null'` for a stored JSON null — exactly the grammar's single "missing" state — and
  distinguishes `'true'`/`'false'` from `'integer'`, without which type-strictness would be
  unrepresentable, since a value accessor erases a JSON boolean to the 0/1 a number also yields. Field
  paths are **bound parameters**, never interpolated, so the compiler has no injection surface.

  The four places a native query language disagrees with the grammar by default, all of which return
  plausible rows rather than failing:

  - **SQL's three-valued logic.** `json_type(doc, ?) = 'text'` is NULL, not false, for a missing field,
    and `NOT NULL` is NULL — so `{ op: 'not', clause: … }` would drop exactly the rows the grammar
    keeps. Every leaf is forced to 0/1 at the source.
  - **Type-strictness**, per the erasure above: a stored `1` must not match `eq: true`, and a stored
    `true` must not match `eq: 1` — including inside `arrayContains`, where `json_each` reports a
    JSON `true` as value 1.
  - **Ordering of missing values.** The grammar's missing-last is a property of the value, so it
    reverses to missing-_first_ under `desc`; SQL's NULL ordering is a property of the direction. Each
    sort spec compiles to two keys rather than relying on `NULLS LAST`.
  - **Totality.** `id` is appended as the final tiebreaker, without which a cursor cannot point at a
    stable boundary.

  Equivalence is enforced by a conformance corpus — ~70 queries run through both the pushdown and the
  in-memory reference, asserting the same documents in the same order, plus cursor paging as a disjoint
  cover and identical located `StoreQueryError`s for invalid queries. The corpus is built around the
  four traps above (documents that hold a number where another holds a boolean, a JSON null next to an
  absent field, keys containing `.` and `"`, and ties on every sorted field, inserted out of id order).

  One divergence remains, and only for a field holding **mixed types across documents**: SQLite orders
  every number before every string, where the reference stringifies and compares `"10" < "9"`. Within a
  type the two agree exactly.

  - @matatbread/matbot-core@0.4.4
  - @matatbread/matbot-plugin-api@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-core@0.4.3
- @matatbread/matbot-plugin-api@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2
  - @matatbread/matbot-core@0.4.2

## 0.3.10

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10
  - @matatbread/matbot-core@0.3.10

## 0.3.9

### Patch Changes

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

## 0.3.7

### Patch Changes

- @matatbread/matbot-core@0.3.7
- @matatbread/matbot-plugin-api@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4
  - @matatbread/matbot-core@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3
  - @matatbread/matbot-core@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2
  - @matatbread/matbot-core@0.3.2

## 0.2.9

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.9
  - @matatbread/matbot-plugin-api@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8
  - @matatbread/matbot-core@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.7
  - @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6
  - @matatbread/matbot-core@0.2.6

## 0.2.4

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.4
  - @matatbread/matbot-plugin-api@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-core@0.2.3
- @matatbread/matbot-plugin-api@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-core@0.2.2
- @matatbread/matbot-plugin-api@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-core@0.2.1
- @matatbread/matbot-plugin-api@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-core@0.2.0
- @matatbread/matbot-plugin-api@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8
  - @matatbread/matbot-core@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-core@0.1.7
- @matatbread/matbot-plugin-api@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [b40c2ec]
  - @matatbread/matbot-core@0.1.6
  - @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-core@0.1.5
- @matatbread/matbot-plugin-api@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-core@0.1.4
- @matatbread/matbot-plugin-api@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-core@0.1.3
- @matatbread/matbot-plugin-api@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-core@0.1.2
- @matatbread/matbot-plugin-api@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-core@0.1.1
- @matatbread/matbot-plugin-api@0.1.1
