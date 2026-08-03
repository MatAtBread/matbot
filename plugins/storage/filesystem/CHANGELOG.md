# @matatbread/matbot-storage-filesystem

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
