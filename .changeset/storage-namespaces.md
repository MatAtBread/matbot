---
'@matatbread/matbot-plugin-api': patch
'@matatbread/matbot-core': patch
'@matatbread/matbot-storage-filesystem': patch
'@matatbread/matbot-storage-sqlite': patch
'@matatbread/matbot-storage-google-drive': patch
'@matatbread/matbot-storage-profiles': patch
'@matatbread/matbot-browser': patch
---

`StorageBackend.namespaces?(): Promise<string[]>` — a backend can now be enumerated, not only addressed.

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

- **filesystem** — a directory is a namespace when it *directly* holds at least one document. A
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
