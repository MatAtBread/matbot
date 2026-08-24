# @matatbread/matbot-function-tools

## 0.4.9

### Patch Changes

- 7c63ecc: The lambda guidance names its own pathological case: wrapping a single tool call.

  **The 0.4.8 nudge over-corrected.** Told when a lambda pays — a verbose result you need a fraction of, a
  loop, a conditional — the model started wrapping almost every tool call in one, which is worse than the
  behaviour the nudge was written to fix: the same result reaches the conversation either way, and a types
  call plus an authoring round have been spent on a wrapper that reduces nothing. Both texts stated the
  exclusion only as a _cost_ ("not the cheaper route for a couple of small calls"), which is easy to
  rationalise past, and offered two invitations against it.

  So the test is now stated as a single question — **are you REDUCING a result?** — and the exclusion is a
  prohibition rather than a price: do not wrap a single tool call whose result you are not reducing; a body
  that is one `await tool.x(params)` and a `return` of what came back is strictly worse than the call it
  wraps. The tool description gains a `NOT FOR THIS` block saying the same, with a worked anti-example beside
  the two positive ones, and the `lambda` action entry now says outright that it is not a wrapper for a
  single call.

  - @matatbread/matbot-plugin-api@0.4.9

## 0.4.8

### Patch Changes

- b550d6a: `tool_function` now argues for itself in the system prompt, and says plainly when to reach for a lambda.

  **A model that never considers `tool_function` never reads its description.** Left to itself it pulls a
  verbose tool result into the conversation to extract a line of it, and drives a loop a round at a time —
  both of which keep every intermediate listing, row and file body for the rest of the session. The advice
  therefore goes where it is read before the mistake is made: this plugin registers a
  `SystemContextContributor`, and the tool's own description now opens with when to use it rather than what
  it is. Constant text, so it is a stable cache prefix rather than something rebuilt per turn, and it
  appears only when this plugin is loaded — the tool being optional is exactly why the recommendation
  cannot live anywhere else.

  Both are framed on the size and shape of the work, not the number of calls: a lambda is for a VERBOSE
  result you need a fraction of (a count, a total, an aggregate, two fields) and for LOOPS AND CONDITIONALS
  (the same call over n items, read-each-and-decide, retry-until). And it says what it costs — the types
  call plus authoring the body is a call or two, so two direct calls with small results are left alone.
  "More than one call" would be the wrong rule: reaching for the tool is itself more than one call.

- Updated dependencies [b550d6a]
  - @matatbread/matbot-plugin-api@0.4.8

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
