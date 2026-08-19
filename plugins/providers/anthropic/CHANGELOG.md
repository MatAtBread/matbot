# @matatbread/matbot-provider-anthropic

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

- **Optional (providers/anthropic).** A thinking block delivered whole on its opener is no longer
  discarded. The stream handler seeded `{ thinking: '', signature: '' }` on `content_block_start` and
  filled it from the subsequent deltas, which is what the Anthropic API itself sends; an
  Anthropic-compatible gateway that puts the entire payload inline on the opener and sends no deltas
  therefore stored an empty block. The opener's own `thinking` and `signature` are now the seed, so both
  shapes round-trip.
  - @matatbread/matbot-core@0.3.9
  - @matatbread/matbot-plugin-api@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.8
  - @matatbread/matbot-core@0.3.8

## 0.3.7

### Patch Changes

- **Optional (providers/anthropic).** Prompt caching now survives interactive use. On-disk session usage
  put this adapter at ~43% cache hit against 91% for a server-auto-cached provider, from two causes: the
  5-minute TTL expired across ordinary think-time gaps (~81% cold miss at 5-30min, ~100% beyond), and the
  message breakpoint was only placed when the second-to-last _user_ turn ended in a `text` block — so
  tool-result turns (role `user`, last block a `tool_result`) got no breakpoint at all, leaving agentic
  tool loops uncached. Both re-processed the whole prefix as fresh input, which also inflated input-token
  throughput against the endpoint's rate limit.

  The adapter now defaults to the 1-hour cache TTL (`{ type: 'ephemeral', ttl: '1h' }` plus the
  `extended-cache-ttl-2025-04-11` beta); set `parameters.cacheTtl: '5m'` on a provider profile to opt back
  to the 5-minute default. The message breakpoint is placed on the last block whatever its type
  (`text` / `image` / `tool_use` / `tool_result` all accept `cache_control`) and rolls across the two
  most-recent messages, so each turn advances the write frontier while the earlier breakpoint stays inside
  the 20-block lookback for the next request to read from. The system prompt is now sent as a block array
  carrying its own breakpoint: since it renders after `tools`, that anchors tools + system together even
  when a long tool turn pushes the message breakpoints out of lookback range. With the separate tool-def
  anchor the common case uses 4 breakpoints — Anthropic's maximum.

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
