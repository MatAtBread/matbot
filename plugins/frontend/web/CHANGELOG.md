# @matatbread/matbot-frontend-web

## 0.3.7

### Patch Changes

- @matatbread/matbot-core@0.3.7
- @matatbread/matbot-plugin-api@0.3.7

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

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5

- 86fd3fe: File-item sharing and a `copy` action for the `share` tool — item-grain sharing now spans files, not just
  documents, and gains a duplicate-with-ownership mode.

  - **File sharing.** `share`/`unshare`/`ownerOf` now handle the `files` axis (`id` = the file id): a file
    is a data + `<id>.meta.json` PAIR on disk, so sharing links both into the target's file area (named files
    may be nested → the target subdir is created), reads flow through the symlinks to the owner's live file,
    and `unshare` unlinks the pair. `ownerOf('files', id)` reports the owning profile (the read-only badge
    signal). A shared-in file is **read-only**: a `put`/`putTemp` under the shared name throws `ReadOnlyError`
    (it would fork the data and write through the meta symlink to the owner); anonymous puts and delete pass.
    The shared-in file set is seeded at open() (scanning each partition's file area for `.meta.json` symlinks)
    and feeds both the write-guard and Task B's live-watch OR-clause, so an owner's edit to a shared file
    reaches every sharee's firehose connection.
  - **`copy` action.** A new `action: 'copy'` on the `share` tool writes an independent duplicate the target
    fully owns and can edit (unlike `share`'s read-only link). Item ids are preserved (a fresh isolated
    partition keeps intra-set references valid); a shared-in source is dereferenced to its live content.
    Documents copy through the target partition's store; files copy the data + meta pair (a copied file goes
    live via the target's watch pump); skills route through the `SkillManager` (discovered loosely) under
    `runAs(target)` so the copy is indexed into the KnowledgeIndex and evented, falling back to a structural
    doc copy when skills isn't loaded.
  - **`id: '*'`.** `share`, `unshare`, and `copy` accept `*` to mean the whole namespace — every item in the
    source namespace (share skips items that are themselves shared in; unshare drops all target-side links).
  - **Bulk ownership.** The `owner` action with `id: '*'` returns an `owners` map of every shared-in item in
    the namespace to its owner profile (read from the in-memory shared-in set), so a UI can gate a whole
    file/session list's share affordance in one round-trip instead of one `owner` call per item.
  - **Clearer share/copy failures.** When a target profile doesn't isolate the namespace, the error no longer
    claims it "already reads the shared base data" (which read as "the target already has this item" — false
    for an item in your own isolated partition). It now names the intersection of the two profiles' isolated
    sets (the only namespaces shareable between them) and, when the namespace isn't an isolatable axis at all,
    redirects a mis-typed file share to `namespace: "files"` (the common `workspace` ≠ `files` slip). The tool
    description makes the same isolation-axis-vs-content-namespace distinction explicit.
  - **Web frontend (showcase).** File items in the sidebar gain a share affordance mirroring the session one:
    a share button (targets = profiles that isolate `files`) calling `share` with `namespace: 'files'`, and a
    read-only marker on a file shared in from another profile (share button withheld, delete relabelled
    "Remove from my view"). Since a file opens as raw bytes in a new tab — a surface that can carry no banner
    of its own — the list row is where the state has to read: a shared-in row is tinted, stripe-marked, and
    carries its own always-visible line naming the owner ("shared by …" / "shared globally" · read-only). The
    file list stays profile-agnostic — ownership comes from a single `owner`/`*` call, not the workspace tool.

- 86fd3fe: Shared-item live watch: an owner's edit to an item shared **into** another profile now reaches the
  sharee's live view, and every partitioned CRUD stream is unified behind one self-describing change envelope.

  - **API gaps filled.** New `StoreChange` (plugin-api) — `{ operation: 'saved' | 'deleted'; namespace; id;
detail? }`, the payload half of a `Routed` event. It is the generic, self-describing shape every
    partitioned stream now emits (files, skills, future partitioned stores), carrying its own **routing**
    namespace (`'files'` / `'skills'` / a document namespace — not a file's content sub-namespace, which
    rides in `detail`) and item id. This is exactly what a per-connection visibility filter needs, so the
    frontend firehose no longer hardcodes a per-stream routing namespace.
  - **Breaking (optional service).** `WatchVisibility.visible` gains an `id` parameter —
    `visible(viewer, namespace, id, origin)` — and `watchFiles` now yields `Routed<StoreChange>` (was
    `Routed<FileEvent>`). `SkillManager.watch` yields `Routed<StoreChange>` (the bespoke `SkillEvent` type is
    removed). Only consumers of these newer surfaces (the profiles backend, the web firehose) are affected.
  - **Optional (storage-profiles).** `visible` now returns true not only when viewer and origin route the
    namespace to the same partition, but also when the item is **shared into** the viewer's partition — so an
    owner editing a shared-in item is seen live by every sharee, closing the live-update regression profiles
    introduced. Backed by a per-`(partition, namespace)` shared-in id-set built eagerly at open() (scanning
    partitions for symlinks) and maintained on every `share`/`unshare`, so `visible` stays synchronous with no
    `fs` stat on the hot per-connection path.
  - **Optional (frontend/web).** The `/events` firehose feeds `visible` straight from each self-describing
    `StoreChange` (no per-stream namespace constant); the in-process and HTTP transports both normalise file
    and skill events to the same `StoreChange` shape so the UI reads one shape whichever transport is live.

- 11ee5c1: `url_for_resource` no longer takes a `namespace` — the word now means exactly one thing on the wire.

  The parameter was asking the model for a file's _content_ namespace (`"workspace"`), while the `share`
  tool's identically-named parameter takes a storage _isolation axis_ (`"files"`). Same name, two different
  levels, contradictory values for the same file — so a model that had correctly learned one binding
  generalised it to the other and produced calls that could not resolve. The frontend tools are the
  exposure half of stored files and have no business asking which sub-namespace a file was written under.

  `url_for_resource({ name })` now looks the file up by the path it was stored under and sources the route's
  namespace segment from the stored handle, so the minted URL is unchanged. A file with no stored namespace
  has no addressable path under the `/files/<namespace>/<name>` route and reports as not viewable rather
  than minting a URL that would 404. Both frontends (served + in-process DOM) change identically, as they
  share one merged `ToolContracts` entry.

  `workspace` survives only as the name of the tool and the UI panel; `files` only as the storage namespace
  and isolation axis. Neither word now appears at both levels, so `share`'s `namespace: "files"` is the only
  namespace the model is ever asked to supply for a file.

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5

## 0.3.4

### Patch Changes

- 53bf4f8: Partitioned live events now cover skills as well as files, and a profile created mid-session is watched
  without a restart.

  - **Skills fan-out.** `SkillManager.watch()` now yields origin-stamped events (`Routed<SkillEvent>`, the
    acting principal), and the web firehose filters `skill-changed` per connection just like files. A profile
    that isolates the `skills` namespace sees only its own skill CRUD; profiles that don't still see the
    shared/base skills. (The `SkillManager`'s in-memory catalogue is still principal-blind — a separate,
    deeper fix — but the event stream is now partition-correct.)
  - **One generic visibility predicate.** `WatchVisibility` gains `visible(viewer, namespace, origin)` (was a
    file-specific `visibleTo`), defined as `route(viewer, ns) === route(origin, ns)`: routing _both_ sides
    makes it correct whether the origin is a partition (files) or the acting principal (skills), and yields
    "global events for namespaces you haven't isolated, own-partition only for those you have".
  - **Dynamic partitions — no restart.** The profiles backend now feeds one long-lived, origin-stamped file
    broadcaster from a watch pump per partition, and starts a pump the moment a profile is created — so a
    profile made after the frontend connected receives its file events live. (Previously the partition set was
    snapshotted when the watch began, needing a restart to pick up a new profile.)
  - **`profile` tool renamed to `profile_action`** for consistency with the other `*_action` tools.

- 36fee95: The web frontend now honours an `x-matbot-principal` request header as a generic per-request identity
  override, taking precedence over any registered `WebPrincipalResolver` (`headerPrincipal(req) ?? resolver
?? default`). This lets a browser act as a chosen identity even when a resolver (e.g. web-principal-user
  or auth) pins a default. The `headerPrincipal` helper is exported. The shared UI also shows a profile
  selector (left of the title) when a `profile` tool is registered, sending the selected profile as that
  header; it stays hidden otherwise, so default deployments are unchanged. Each profile row gains a gear that
  edits which namespaces the profile isolates — a checklist populated from the tool's `available_namespaces`
  action, applied via `set_isolated` — and the new-profile row gains a matching (collapsed) chooser so a
  profile's isolated set can be picked at creation.

  The URL fragment now accepts an optional leading profile: `#<profile>:<session>~<params>`, every part
  optional so existing `#<session>` / `#<session>~<params>` links are untouched. At load — before any
  session loads — a `#<profile>:…` prefix (or a lone `#<profile>` that names an existing profile) adopts
  that profile, then strips itself from the hash. Each profile row in the selector gains a link icon that
  copies its shareable `#<profile>` URL to the clipboard.

- a3cfbfa: Serve profile-partitioned files by URL. A browser GET (an `<img>`, a download link) can't send the
  `x-matbot-principal` header, so `url_for_resource` now bakes the current principal into the path as a
  leading `~<principal>` segment when profile-aware storage is active, and the `GET /files` route parses it
  back out and reads under that principal. `~` is excluded from principal ids and namespaces, so the
  segment is unambiguous; without profiles the URL is byte-identical to before.

  Also fixes a deep-link bug: the `hashchange` handler didn't strip a `#<profile>:` prefix the way the
  load-time parser does, so navigating to a profile deep-link mid-session treated `profile:session` as a
  session id. It now splits the profile off — switching (reload) when it differs from the active one,
  stripping it in place when it matches — before parsing the session fragment.

- c3a1b00: The chat header gains a share button (shown only when a `profile` tool is registered and a session is
  open). Clicking it pops a small menu of target profiles — those that isolate `sessions`, minus the
  active one — and each pick POSTs `share` (`{ namespace: 'sessions', id: <session>, target }`) for the
  open conversation, reporting success or the backend's error inline. A session shared IN from another
  profile (resolved via the `owner` action on open) hides the share button — you can't re-share what you
  don't own — and shows a "read-only · &lt;owner&gt;" badge. It all stays hidden in default deployments, so
  nothing changes when profile-aware storage isn't active.
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

- 5c244c1: fix(frontend-web): click-to-install banners name the exact package and discover locally first

  The "Enable workspace", "Install edit-session", and "Enable sessions" banners sent the
  LLM a partial plugin name, which led it to guess registry name variations. They now name
  the exact package (`@matatbread/matbot-tool-workspace`, `@matatbread/matbot-edit-session`,
  `@matatbread/matbot-sessions`), instruct it to run `discover_local` first and add from the
  local cache if present, and only then fall back to npm/github by that exact name — with an
  explicit "do not guess other name variations".

  - @matatbread/matbot-core@0.1.7
  - @matatbread/matbot-plugin-api@0.1.7

## 0.1.6

### Patch Changes

- b40c2ec: fix: correct misplaced workspace dependencies

  Several plugins declared type-only `@matatbread/*` imports (the runtime coupling
  is via the service registry, not the import) under `dependencies`, which made a
  packed/published tarball try to install them from the registry:

  - frontend-web: `matbot-skills` → devDependencies
  - cognition: `matbot-skills`, `matbot-triggers` → devDependencies
  - web-principal-user: `matbot-frontend-web` → devDependencies
  - docker-bash: removed `matbot-tool-bash` (entirely unused; the "replaces bash"
    relationship is runtime via the registry, never imported)

- Updated dependencies [b40c2ec]
  - @matatbread/matbot-core@0.1.6
  - @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-core@0.1.5
- @matatbread/matbot-plugin-api@0.1.5
- @matatbread/matbot-skills@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-core@0.1.4
- @matatbread/matbot-plugin-api@0.1.4
- @matatbread/matbot-skills@0.1.4

## 0.1.3

### Patch Changes

- 589e061: Ship the static UI assets (index.html, app.js, browser.js, http-transport.js,
  favicon) by listing them concretely in `files`. Previously `files` was `["src"]`, so
  the published package omitted the web UI it serves at runtime; concrete entries also
  let a github/http install mirror them (a raw host can't be directory-listed).
  - @matatbread/matbot-core@0.1.3
  - @matatbread/matbot-plugin-api@0.1.3
  - @matatbread/matbot-skills@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-core@0.1.2
- @matatbread/matbot-plugin-api@0.1.2
- @matatbread/matbot-skills@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-core@0.1.1
- @matatbread/matbot-plugin-api@0.1.1
- @matatbread/matbot-skills@0.1.1
