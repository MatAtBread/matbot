# @matatbread/matbot-provider-chatjimmy

## 0.4.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.7

## 0.4.6

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
  - @matatbread/matbot-plugin-api@0.4.5

## 0.4.4

### Patch Changes

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

- 4276c38: **Optional (providers/chatjimmy).** The ChatJimmy adapter is no longer `private` — it publishes as
  `@matatbread/matbot-provider-chatjimmy` and is a dependency of the CLI, so it appears in the first-run
  setup wizard's provider list (option 5) and resolves by bare package name from an installed matbot as
  well as a source checkout. A hosted llama endpoint: keyless, non-streaming (one `text-delta` per turn),
  text-only and no tool-calling — useful as a low-latency comparison point rather than a
  general-purpose provider.
- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5
