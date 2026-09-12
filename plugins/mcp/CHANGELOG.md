# @matatbread/matbot-tool-mcp

## 0.4.8

### Patch Changes

- Every privileged confirmation is now a structured `confirm` field, and connecting an MCP server asks.

  - `mcp_action add` was ungated in both the node and http plugins — only `remove` asked, which is backwards:
    connecting registers a remote party's tools for the rest of the session, and the local (stdio) variant
    spawns a child process on the host. Both now confirm, and the local prompt names the command line.
  - The eight remaining free-text `[y/N]` prompts (five in `provider`, three across `mcp`/`mcp-http`) are
    `type: 'confirm'` fields answered with the canonical `CONFIRM_YES`/`CONFIRM_NO` tokens, instead of a regex
    over a rendered — and potentially localised — label. Rich frontends render real buttons for these; the CLI
    renders `[yes/NO]` and prefix-matches, so `y` still works. Every non-interactive caller keeps declining, as
    the `CONFIRM_NO` default is what it always resolved to.
  - `confirmAction` went from three copies to one per dependency edge: shared within `tool-plugin`, and
    exported from `mcp-http` for the node `mcp` plugin that already hard-depends on it.

- Updated dependencies
  - @matatbread/matbot-mcp-http@0.4.8

## 0.4.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.7
- @matatbread/matbot-mcp-http@0.4.7

## 0.4.6

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.6
- @matatbread/matbot-mcp-http@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
  - @matatbread/matbot-plugin-api@0.4.5
  - @matatbread/matbot-mcp-http@0.4.5

## 0.4.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.4
- @matatbread/matbot-mcp-http@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.3
- @matatbread/matbot-mcp-http@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2
  - @matatbread/matbot-mcp-http@0.4.2

## 0.3.10

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.10
  - @matatbread/matbot-mcp-http@0.3.10

## 0.3.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.9
- @matatbread/matbot-mcp-http@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8
  - @matatbread/matbot-mcp-http@0.3.8

## 0.3.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.3.7
- @matatbread/matbot-mcp-http@0.3.7

## 0.3.5

### Patch Changes

- Updated dependencies [3e662d0]
- Updated dependencies

  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-mcp-http@0.3.5

- Updated dependencies [86fd3fe]
  - @matatbread/matbot-plugin-api@0.3.5
  - @matatbread/matbot-mcp-http@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [c3a1b00]
  - @matatbread/matbot-plugin-api@0.3.4
  - @matatbread/matbot-mcp-http@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3
  - @matatbread/matbot-mcp-http@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2
  - @matatbread/matbot-mcp-http@0.3.2

## 0.2.9

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.9
- @matatbread/matbot-mcp-http@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.8
  - @matatbread/matbot-mcp-http@0.2.8

## 0.2.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.7
- @matatbread/matbot-mcp-http@0.2.7

## 0.2.6

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.2.6
  - @matatbread/matbot-mcp-http@0.2.6

## 0.2.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.4
- @matatbread/matbot-mcp-http@0.2.4

## 0.2.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.3
- @matatbread/matbot-mcp-http@0.2.3

## 0.2.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.2
- @matatbread/matbot-mcp-http@0.2.2

## 0.2.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.1
- @matatbread/matbot-mcp-http@0.2.1

## 0.2.0

### Patch Changes

- @matatbread/matbot-plugin-api@0.2.0
- @matatbread/matbot-mcp-http@0.2.0

## 0.1.8

### Patch Changes

- Updated dependencies [4891bf7]
  - @matatbread/matbot-plugin-api@0.1.8
  - @matatbread/matbot-mcp-http@0.1.8

## 0.1.7

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.7
- @matatbread/matbot-mcp-http@0.1.7

## 0.1.6

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.6
- @matatbread/matbot-mcp-http@0.1.6

## 0.1.5

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.5
- @matatbread/matbot-mcp-http@0.1.5

## 0.1.4

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.4
- @matatbread/matbot-mcp-http@0.1.4

## 0.1.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.3
- @matatbread/matbot-mcp-http@0.1.3

## 0.1.2

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.2
- @matatbread/matbot-mcp-http@0.1.2

## 0.1.1

### Patch Changes

- @matatbread/matbot-plugin-api@0.1.1
- @matatbread/matbot-mcp-http@0.1.1
