# @matatbread/matbot-tool-store

## 0.4.5

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

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
  - @matatbread/matbot-plugin-api@0.4.5

## 0.4.4

### Patch Changes

- A generated store tool no longer silently discards a query grammar key passed beside `action`.

  `{ "action": "query", "limit": 0 }` — the grammar flattened one level up, instead of nested under the
  `query` parameter — reached `store.query(input.query ?? {})` as `{}`. The limit was dropped, the query
  degraded to match-everything, and the **count form came back as every document in the store plus a
  `total`**, which reads exactly like a working answer. This is the silent miss `validateQuery` rejects
  unknown top-level keys to prevent, reappearing at the tool boundary, where `validateQuery` cannot see
  it: the misplaced key never becomes part of a `StoreQuery` at all.

  The cause was the tool's own description. It documented the `StoreQuery` _type_ but never the _call
  envelope_, leaving the nesting to be inferred — so the description now leads with the shape of the
  call (`{ "action": "query", "query": { … } }`), states that every grammar key sits inside it, and
  gives the count form as a complete call rather than the fragment "pass `limit: 0`", which read as an
  instruction to pass it at the top level. Misplacing `where`/`sort`/`limit`/`cursor`/`immutable` is now
  also rejected with an error naming the keys and the correct call, rather than answered.

  - @matatbread/matbot-plugin-api@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2

## 0.3.10

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2

## 0.2.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8

## 0.2.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6

## 0.2.4

### Patch Changes

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
