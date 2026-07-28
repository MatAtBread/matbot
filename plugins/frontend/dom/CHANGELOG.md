# @matatbread/matbot-frontend-dom

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
