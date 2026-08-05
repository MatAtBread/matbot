// ── TypeScript ──────────────────────────────────────────────────────────────

/**
 * Erases TypeScript types from a source string, returning runnable JavaScript. Type-stripping is
 * foundational — the harness ships raw `.ts` and any code compiled at runtime must have its types
 * removed before it can execute — so every execution environment provides one, and it lives as a fixed
 * runtime capability (on {@link MatbotRuntime}) the host supplies per platform, not a swappable service:
 * node uses its built-in `stripTypeScriptTypes`, the browser bundle uses sucrase. A consumer that
 * compiles source at runtime (e.g. `tool_function`) calls this instead of importing a platform stripper.
 *
 * `strip` may be async: a platform whose stripper loads lazily (the browser fetches sucrase on first use)
 * returns a promise; a synchronous stripper (node) returns the string directly — callers `await` either.
 * It is type-erasure, not full transpilation: node's stripper is erasable-only (enums/namespaces throw),
 * sucrase is more permissive, so authors should keep to erasable TypeScript to stay portable.
 */
export interface TypeScriptStripper {
  strip(source: string): string | Promise<string>;
}

/**
 * Optional, node-only developer-experience service: the live `.d.ts` of the types the loaded tools
 * expose — what `toolResult(invokeTool(…, name, …))`, or a `function-tools` `await tool.name(…)`, resolves
 * to — derived by compiling each loaded plugin's `declare module '@matatbread/matbot-plugin-api'`
 * augmentations. The runtime registry can't supply this (result types are erased); only a TypeScript
 * program reading the source can. Consumers that generate or compose tool-calling code use it so the model
 * isn't guessing return shapes. Absent where no TypeScript program can run (the browser today) — a consumer
 * must degrade (guess-and-run) when `services.ToolTypeIndex` is undefined.
 *
 * The result is rebuilt lazily and cached, invalidated when the tool set changes. Tools the source scan
 * can't reach (a `function-tools` function) contribute their types by declaring a `toolContract` string on
 * their registered {@link Tool} — identical in shape to a `ToolContracts` arm; the index splices it off the
 * live registry, so no separate registration step is needed.
 */
export interface ToolTypeIndex {
  /** Self-contained type declarations as a `.d.ts` string: the source-derived `ToolContracts` augmentations
   *  merged with the arms of every other live tool, plus `declare const tool: ToolProxy` — the overloaded
   *  proxy a generator writes `await tool.x(params)` against. */
  dts(): Promise<string>;
  /** Type-check a TypeScript `snippet` against exactly the {@link dts} above — the `tool` proxy ({@link
   *  ToolProxy}: each multi-action tool an overload set, so `await tool.x(params)` narrows its result by the
   *  params) is in scope. Returns human-readable diagnostics scoped to the snippet ([] means clean). A
   *  composer uses it to catch bad tool-call code before running/registering it. */
  check(snippet: string): Promise<string[]>;
  /** Per live tool (that has a contract): the `params`/`result` wire text, flattened from the one contract —
   *  a source tool's `ToolContracts` arms (via the source scan) or a source-less tool's `toolContract` string.
   *  The single contract is thus also the source of the wire description; the host folds this into the
   *  outgoing tool descriptions at the turn's dispatch edge. A tool with only a loose `inputSchema` (no
   *  contract) is absent. */
  wireContracts(): Promise<Record<string, { params: string; result: string }>>;
}
