# @matatbread/matbot-tool-plugin

## 0.4.13

### Patch Changes

- 5e95597: `plugin add` over http: offer to install the dependencies a source-fetch cannot bring. A URL-fetched
  plugin copies one package's own files, not a dependency graph, so one with registry dependencies failed
  to activate on its first unresolved import. It now resolves what the plugin declares, asks once with the
  full transitive list, installs into the plugin's own cache root under `.plugins/` (the same
  plan/apply path a local plugin takes — not the user's project, where `pnpm add` refuses at a workspace
  root and otherwise writes a fetched plugin's dependencies into a tracked manifest), and retries
  activation.

  Also fixes the missing-package remedy being unreachable for that route, which it was for two reasons:
  it was matched off Node's `Cannot find package 'x'` where a bare import from inside `.plugins/` is
  answered by ts-hooks' own `Cannot resolve "x"`, and `loadPlugins` rethrew a bare `new Error(message)`
  that dropped the `ERR_MODULE_NOT_FOUND` code the remedy keys on. The rethrow now carries the original
  as `cause` and copies its `code`.

- 8cd085b: Link a local plugin's host singletons whether or not it has registry dependencies to install. The link
  loop was behind an early return in `applyProvision`, so a plugin whose only dependency is the
  `@matatbread/matbot-plugin-api` peer got no `node_modules` and no link at all.

  Also asks the right question for the link target (`hostOwnPackageDir`, not `hostPackageDirFrom(name,
pluginDir)`, which answers with the author's own devDependency copy when one is installed), and replaces
  a path that does not lead to the host's copy rather than accepting any path that exists.

- 31bae3c: `provider update`: change `model`, `endpoint`, `parameters` or `maxRounds` on an existing profile
  without touching its credentials. Adds `ProviderPatch` to the `provider` tool contract and the
  `applyProviderPatch`/`patchedFields` policy to plugin-api (re-exported by core). Also fixes the block
  remover swallowing the top-level section that follows the last provider — a pre-existing
  `provider remove` bug.
- Updated dependencies [5e95597]
- Updated dependencies [31bae3c]
  - @matatbread/matbot-core@0.4.13
  - @matatbread/matbot-plugin-api@0.4.13

## 0.4.7

### Patch Changes

- @matatbread/matbot-core@0.4.7
- @matatbread/matbot-plugin-api@0.4.7

## 0.4.6

### Patch Changes

- @matatbread/matbot-core@0.4.6
- @matatbread/matbot-plugin-api@0.4.6

## 0.4.5

### Patch Changes

- Updated dependencies [99152f3]
- Updated dependencies [20d87fe]
- Updated dependencies [e65e2a3]
  - @matatbread/matbot-plugin-api@0.4.5
  - @matatbread/matbot-core@0.4.5

## 0.4.4

### Patch Changes

- @matatbread/matbot-core@0.4.4
- @matatbread/matbot-plugin-api@0.4.4

## 0.4.3

### Patch Changes

- @matatbread/matbot-core@0.4.3
- @matatbread/matbot-plugin-api@0.4.3

## 0.4.2

### Patch Changes

- One shared contract for the `plugin` and `provider` tools, and named result shapes that can be augmented.

  Both tools have a node and a browser implementation, and each declared its own `ToolContracts` arm. A registry key is registered by declaration merging, so two declarations are legal only while identical — these were not, and `buildMatbotToolsDts` never read the Program's diagnostics, so one won on file order and its shape was emitted as the contract. In any tree containing `plugins/`, the browser shapes won, and node's generated code was graded against them: the check loop rejected `providers[].hasCredentials` (what node returns) and accepted `providers[].hasKey` (`undefined` at runtime).

  Both now declare `PluginToolContract` / `ProviderToolContract` from plugin-api. Node's names win, so the browser tool renames `hasKey` → `hasCredentials`, `adapter` → `module`, `ProviderRow` → `ProviderSummary`, and takes `ModelParameters` for `parameters`. `FailedPlugin` moves from core to plugin-api (still re-exported from core). Result shapes are named, exported interfaces, so a host overriding a builtin tool can augment them instead of being unable to describe its own return.

  Duplicate registry declarations are now reported rather than silently resolved.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.4.2
  - @matatbread/matbot-core@0.4.2

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

## 0.3.9

### Patch Changes

- **Optional (tool-plugin, browser).** The provider tools' `PARAMETERS` list is labelled as an example,
  not a schema. Both the node `provider` tool and its browser counterpart list `maxTokens` /
  `temperature` / `topP` under a heading that read as the permitted set, so anything absent from it looked
  unsupported. `parameters` is passed to the endpoint unmodified and its contents are model- and
  provider-specific; the heading now says so.
  - @matatbread/matbot-core@0.3.9
  - @matatbread/matbot-plugin-api@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8
  - @matatbread/matbot-core@0.3.8

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

- 84397a6: fix(tool-plugin): discover_local resolves conditional `exports`

  `resolveExportsMain` only handled a string `exports["."]`; a plugin using the
  conditional form (`{ browser, import, default }`, e.g. frontend-web) resolved to
  `undefined` and was silently skipped during discovery — so a cached/source plugin
  with a browser bundle never appeared in `discover_local`. Now resolves the node
  ESM conditions (node/import/default), skipping browser/require.

  - @matatbread/matbot-core@0.1.5
  - @matatbread/matbot-plugin-api@0.1.5

## 0.1.4

### Patch Changes

- 7ea2a82: Clarify the `plugin` tool's specifier docs: show the raw `github:owner/repo/subdir#ref`
  form for source plugins (a repo subdir), state that the `#path:`/git forms are only for
  fully-packaged published packages, and instruct the model to pass a user-supplied
  specifier verbatim. Prevents the model rewriting a working github specifier into a
  package-manager form that fails on workspace/raw source.
  - @matatbread/matbot-core@0.1.4
  - @matatbread/matbot-plugin-api@0.1.4

## 0.1.3

### Patch Changes

- fe27c9f: When materialising a remote (github/http) plugin, also fetch the concrete files it
  declares in `files` (e.g. static UI assets), not just its import graph. A raw host
  can't be directory-listed, so asset-bearing plugins like frontend-web previously
  fetched their code but none of their runtime assets. Directory and glob entries are
  skipped; missing files warn and are skipped (best-effort).
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
