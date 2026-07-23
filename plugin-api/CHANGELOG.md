# @matatbread/matbot-plugin-api

## 0.3.4

### Patch Changes

- c3a1b00: New branded `ReadOnlyError` (`readOnlyError()` factory + `isReadOnlyError()` guard, alongside the other
  brand-based typed errors) for a `Store` write rejected because the current principal does not own the
  item — e.g. a session shared read-only from another profile's partition.

  The turn pump now catches it around the persist-at-turn-start write in `SessionRunner`: a read-only
  rejection is surfaced as a per-turn `error` event and the submission is dropped, instead of escaping the
  detached pump and crashing the host. Any other write failure stays fatal as before. Detection uses the
  brand guard, never `instanceof`, so it holds across a skewed/duplicated plugin-api install.

## 0.3.3

### Patch Changes

- Native Google Gemini provider + provider-agnostic round-trip metadata.

  - New `@matatbread/matbot-provider-google`: one `module:`, two wire formats chosen by endpoint path — native `generateContent` adapter, or the openai-compat adapter in `gemini` mode. Thought-signature round-trip, foreign/unsignable tool calls degraded to text context notes (not elided), and tool schemas sanitized to Gemini's strict OpenAPI subset.
  - `plugin-api`/`core`: replaced the tool-call `signature?: string` with an augmentable `meta?: ProviderMeta`. Providers declare their own namespaced slice from their own module, so core carries round-trip metadata opaquely and never changes when a provider adds its own.
  - `openai-compat`: opt-in `gemini` mode (thought-signature round-trip via `extra_content.google.thought_signature` + foreign-call degradation); homes the `ProviderMeta.google` augmentation.
  - `tool-router`: order the working set by adoption (first-seen) so it grows append-only, keeping the tools prefix byte-stable for prompt caching.

## 0.3.2

### Patch Changes

- Typed, self-repairing codegen pipeline: ToolProxy trailing catch-all overload (sound `ReturnType`, better bad-call errors, dynamic union dispatch); one worker-hosted checker in tool-types with annotated diagnostics and a structural cast gate (no main-thread block, no fallback); skills_compiler embeds the tool-contract dts in every prompt, threads the interactive prompt channel into demonstrations, distils honestly, verifies installs, and repairs over 4 passes; function-tools enforces lambda's one-argument convention.

## 0.2.9

## 0.2.8

### Patch Changes

- Patch release.

## 0.2.7

## 0.2.6

### Patch Changes

- Thread the `ToolEvent<Result>` generic through the producer side and add per-call result discrimination for multi-action tools. `ToolExecutor<R>` / `Tool<R>` now carry the result type at the source; a tool declares it once by augmenting `ToolContracts` (the executor binds via `ToolExecutor<ToolResultOf<'name'>>`, so the two can't drift). Multi-action tools register a union of `ToolContract<Result, Args>` arms, and `invokeTool` narrows the result by the params it's called with. Type-level only — no behaviour change.

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

## 0.1.8

### Patch Changes

- 4891bf7: fix: prevent (and survive) duplicate plugin-api/core copies splitting the principal carrier

  Two layers of fix for the "No PrincipalCarrier installed" failure seen when a published
  install ends up with two physical copies of the host singletons:

  - **Caret dependency ranges.** Inter-package and peer deps were published as exact pins
    (`workspace:*` → `0.1.7`), so any version skew (e.g. an in-place CLI upgrade over an older
    tree) forced npm to nest a second copy of `plugin-api`/`core` — which `npm dedupe` cannot
    merge across exact-but-different requirements. They now publish as caret (`workspace:^` →
    `^0.1.7`), so a single highest copy satisfies the whole tree.

  - **Process-global principal carrier.** The carrier was a module-level `let`, so two copies of
    `plugin-api` each had their own — the host installed into one, a plugin read the other, and
    every principal read threw. It now lives on `globalThis` under `Symbol.for(...)`, so all
    copies share the single carrier the host installs at boot. Deduping is still preferred; this
    makes duplication harmless rather than fatal.

## 0.1.7

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.1.1
