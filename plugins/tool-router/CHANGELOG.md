# @matatbread/matbot-tool-router

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

- Native Google Gemini provider + provider-agnostic round-trip metadata.

  - New `@matatbread/matbot-provider-google`: one `module:`, two wire formats chosen by endpoint path — native `generateContent` adapter, or the openai-compat adapter in `gemini` mode. Thought-signature round-trip, foreign/unsignable tool calls degraded to text context notes (not elided), and tool schemas sanitized to Gemini's strict OpenAPI subset.
  - `plugin-api`/`core`: replaced the tool-call `signature?: string` with an augmentable `meta?: ProviderMeta`. Providers declare their own namespaced slice from their own module, so core carries round-trip metadata opaquely and never changes when a provider adds its own.
  - `openai-compat`: opt-in `gemini` mode (thought-signature round-trip via `extra_content.google.thought_signature` + foreign-call degradation); homes the `ProviderMeta.google` augmentation.
  - `tool-router`: order the working set by adoption (first-seen) so it grows append-only, keeping the tools prefix byte-stable for prompt caching.

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2
