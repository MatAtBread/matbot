# @matatbread/matbot-function-tools

## 0.4.3

### Patch Changes

- @matatbread/matbot-plugin-api@0.4.3

## 0.4.2

### Patch Changes

- A defined function's `inputSchema` now carries the structure its signature declared.

  Its params are projected twice from one parse — verbatim into the `toolContract` (TS to TS, lossless) and into the `inputSchema` — and the second projection string-matched the whole annotation, so every structural shape collapsed: `'a' | 'b'` → `{}`, `string[]` → `{ type: 'array' }`, `{ sql: string; limit?: number }` → a bare `{ type: 'object' }`. Since the `inputSchema` is what the provider is given and what `json-validation` enforces, the model was shown a contract in the tool description stronger than the schema backing it.

  Literal unions now yield `enum`, arrays `items`, inline object types `properties`/`required`, `Record`/index signatures `additionalProperties`, and primitive unions a `type` array. The conversion stays deliberately partial — a named or imported type, a union with a structural arm, and a tuple's element types degrade to the permissive form rather than to a guessed constraint. A defined tool now rejects calls it previously accepted, which is the point of it.

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

- Typed, self-repairing codegen pipeline: ToolProxy trailing catch-all overload (sound `ReturnType`, better bad-call errors, dynamic union dispatch); one worker-hosted checker in tool-types with annotated diagnostics and a structural cast gate (no main-thread block, no fallback); skills_compiler embeds the tool-contract dts in every prompt, threads the interactive prompt channel into demonstrations, distils honestly, verifies installs, and repairs over 4 passes; function-tools enforces lambda's one-argument convention.
- Updated dependencies
  - @matatbread/matbot-plugin-api@0.3.2
