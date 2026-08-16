---
'@matatbread/matbot-storage-sqlite': patch
'@matatbread/matbot-tool-store': patch
---

A namespace is now stored under its own name, and validated where untrusted ones arrive.

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
