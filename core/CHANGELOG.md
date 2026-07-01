# @matatbread/matbot-core

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8

## 0.2.7

### Patch Changes

- Release 0.2.7
  - @matatbread/matbot-plugin-api@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6

## 0.2.4

### Patch Changes

- Release: web_user_environment + compact_sessions tools, triggers reworked to fire tools with the user/agent × ephemeral/durable orthogonality, quiescent-edge registry application, google-drive storage backend, durable screen context / retractAndRerun, persisted token usage, plus the npm-publishing restructure and assorted fixes. See CHANGELOG.md.
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

- b40c2ec: fix(core/config): tolerate empty `plugins:` / `providers:` sections

  A bare `plugins:` (or `providers:`) key with no entries parses to YAML `null`,
  which the loader rejected with `"plugins" must be a sequence (list)`. This is the
  state `plugin remove` leaves behind when it deletes the last list item, so a config
  that had every plugin removed failed to boot. An empty/null section now reads as
  empty.

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
