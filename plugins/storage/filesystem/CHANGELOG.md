# @matatbread/matbot-storage-filesystem

## 0.4.7

### Patch Changes

- @matatbread/matbot-core@0.4.7
- @matatbread/matbot-plugin-api@0.4.7
- @matatbread/matbot-files-node@0.4.7

## 0.4.6

### Patch Changes

- @matatbread/matbot-core@0.4.6
- @matatbread/matbot-plugin-api@0.4.6
- @matatbread/matbot-files-node@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
- Updated dependencies [e65e2a3]
  - @matatbread/matbot-plugin-api@0.4.5
  - @matatbread/matbot-core@0.4.5
  - @matatbread/matbot-files-node@0.4.5

## 0.4.4

### Patch Changes

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

- @matatbread/matbot-core@0.4.4
- @matatbread/matbot-plugin-api@0.4.4
- @matatbread/matbot-files-node@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-core@0.4.3
- @matatbread/matbot-plugin-api@0.4.3
- @matatbread/matbot-files-node@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2
  - @matatbread/matbot-core@0.4.2
  - @matatbread/matbot-files-node@0.4.2

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
  - @matatbread/matbot-core@0.3.10
  - @matatbread/matbot-files-node@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-core@0.3.9
- @matatbread/matbot-plugin-api@0.3.9
- @matatbread/matbot-files-node@0.3.9

## 0.3.8

### Patch Changes

- **A listing query no longer re-parses documents that have not changed.** `FilesystemStore` honours
  `StoreQuery.immutable` with a parse cache validated by a fresh `stat` (mtime + size) on **every**
  query — not by write-through invalidation — so a document written by another process (a detached
  background job, an editor) invalidates exactly like a local one, and a stale entry cannot outlive
  the stat that disagrees with it. Writes through the store additionally drop their own entry, closing
  the window where a rewrite of identical length within one filesystem timestamp tick would look
  unchanged. Bounded at 64 MB of source bytes, least-recently-used evicted, so a store larger than the
  budget degrades to the previous behaviour for the overflow rather than growing without limit.
  Measured on 213 real session documents (52 MB): 591ms cold, 6ms warm; a query without the flag is
  unchanged at 535ms.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8
  - @matatbread/matbot-core@0.3.8
  - @matatbread/matbot-files-node@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-core@0.3.7
- @matatbread/matbot-plugin-api@0.3.7
- @matatbread/matbot-files-node@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-files-node@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-core@0.3.5
  - @matatbread/matbot-files-node@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [36fee95]
- Updated dependencies [c3a1b00]
  - @matatbread/matbot-files-node@0.3.4
  - @matatbread/matbot-plugin-api@0.3.4
  - @matatbread/matbot-core@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3
  - @matatbread/matbot-core@0.3.3
  - @matatbread/matbot-files-node@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2
  - @matatbread/matbot-core@0.3.2
  - @matatbread/matbot-files-node@0.3.2

## 0.2.9

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.9
  - @matatbread/matbot-plugin-api@0.2.9
  - @matatbread/matbot-files-node@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8
  - @matatbread/matbot-core@0.2.8
  - @matatbread/matbot-files-node@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.7
  - @matatbread/matbot-plugin-api@0.2.7
  - @matatbread/matbot-files-node@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6
  - @matatbread/matbot-core@0.2.6
  - @matatbread/matbot-files-node@0.2.6

## 0.2.4

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.4
  - @matatbread/matbot-plugin-api@0.2.4
  - @matatbread/matbot-files-node@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-core@0.2.3
- @matatbread/matbot-plugin-api@0.2.3
- @matatbread/matbot-files-node@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-core@0.2.2
- @matatbread/matbot-plugin-api@0.2.2
- @matatbread/matbot-files-node@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-core@0.2.1
- @matatbread/matbot-plugin-api@0.2.1
- @matatbread/matbot-files-node@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-core@0.2.0
- @matatbread/matbot-plugin-api@0.2.0
- @matatbread/matbot-files-node@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8
  - @matatbread/matbot-core@0.1.8
  - @matatbread/matbot-files-node@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-core@0.1.7
- @matatbread/matbot-plugin-api@0.1.7
- @matatbread/matbot-files-node@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [b40c2ec]
  - @matatbread/matbot-core@0.1.6
  - @matatbread/matbot-files-node@0.1.6
  - @matatbread/matbot-plugin-api@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-core@0.1.5
- @matatbread/matbot-plugin-api@0.1.5
- @matatbread/matbot-files-node@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-core@0.1.4
- @matatbread/matbot-plugin-api@0.1.4
- @matatbread/matbot-files-node@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-core@0.1.3
- @matatbread/matbot-plugin-api@0.1.3
- @matatbread/matbot-files-node@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-core@0.1.2
- @matatbread/matbot-plugin-api@0.1.2
- @matatbread/matbot-files-node@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-core@0.1.1
- @matatbread/matbot-plugin-api@0.1.1
- @matatbread/matbot-files-node@0.1.1
