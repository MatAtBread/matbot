# @matatbread/matbot-files-node

## 0.3.7

### Patch Changes

- @matatbread/matbot-core@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-core@0.3.5

- @matatbread/matbot-core@0.3.5

## 0.3.4

### Patch Changes

- 36fee95: Fix `FilesystemFileStore.watch()` throwing `ENOENT` when its directory does not yet exist. It now
  ensures the directory first (mirroring `put()`/`list()`), so a registered `StorageBackend` acting as the
  boot backend — where the host skips its own `.data/files` mkdir — no longer crashes the web frontend at
  startup on a fresh data directory.
- Updated dependencies [c3a1b00]
  - @matatbread/matbot-core@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.3.3

## 0.3.2

### Patch Changes

- @matatbread/matbot-core@0.3.2

## 0.2.9

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.9

## 0.2.8

### Patch Changes

- @matatbread/matbot-core@0.2.8

## 0.2.7

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.7

## 0.2.6

### Patch Changes

- @matatbread/matbot-core@0.2.6

## 0.2.4

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-core@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-core@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-core@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-core@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-core@0.2.0

## 0.1.8

### Patch Changes

- @matatbread/matbot-core@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-core@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [b40c2ec]
  - @matatbread/matbot-core@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-core@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-core@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-core@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-core@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-core@0.1.1
