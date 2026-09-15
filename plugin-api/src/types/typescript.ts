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
 * Optional, host-supplied: compiles already-stripped JavaScript into an async function whose SYNCHRONOUS
 * execution is bounded. Model-authored code (a `tool_function` body) runs on the one event loop every
 * session, frontend and schedule shares, so a loop that never awaits freezes all of them — and nothing
 * in-process can stop it, an abort signal included, since stopping needs the loop to yield. Only the
 * stretches between awaits are bounded: a body waiting on a slow tool call is not doing work.
 *
 * Absent ⇒ a consumer compiles with `new AsyncFunction` and runs unbounded, which is all a platform with
 * no way to interrupt synchronous code (the browser) can do. An embedder may register its own.
 */
export interface FunctionRunner {
  /** Compile `body` as the body of an async function taking `params`. Throws on a syntax error. A call
   *  stopped at the limit rejects with an error whose `code` is {@link FUNCTION_TIMEOUT}. */
  compile(params: readonly string[], body: string): (...args: unknown[]) => Promise<unknown>;
}

/** The `code` on the error a {@link FunctionRunner} rejects with when it stops a run at its limit, so a
 *  consumer can tell a stopped runaway from an ordinary failure without matching message text. */
export const FUNCTION_TIMEOUT = 'FUNCTION_TIMEOUT';

/**
 * One finding from {@link ToolTypeIndex.check} — the record, not a rendering of it.
 *
 * `rendered` travels WITH the record rather than being left for the consumer to rebuild: the annotated
 * form (caret-anchored frame, related locations, a directed hint) is the thing a model repairs from,
 * and the renderer lives behind the service. So a consumer displays `rendered` and counts, groups or
 * routes on the fields — instead of regexing `line \d+ TS\d+` back out of prose, which is what the
 * flattened `string[]` made every consumer do.
 */
export interface ToolCheckDiagnostic {
  /** The rule's one name, in every renderer: `TS2339`, or `CAST-GATE` for a structural cast-gate finding. */
  label:    string;
  /** The numeric code. Cast-gate findings use a private 9000x range — read {@link syn}, not the number. */
  code:     number;
  message:  string;
  file?:    string;
  line?:    number;
  col?:     number;
  /** Caret-anchored source frame. */
  frame?:   string;
  related?: string[];
  hint?:    string;
  /** A structural cast-gate finding (a rule of this harness) rather than a `tsc` error. */
  syn?:     true;
  /** The annotated block for display: message, frame, related locations and hint. */
  rendered: string;
}

/**
 * The outcome of a {@link ToolTypeIndex.check}. `ok` is `total === 0`.
 *
 * Detail is capped, because a cascade of errors must not become the bulk of a turn's context — but the
 * cap is expressed as data, not smuggled in as a prose element of the findings array. It was appended as
 * one: `diagnostics.length` then counted a summary line as a finding, and any per-code breakdown derived
 * by iterating the array was wrong wherever an overflow had occurred.
 */
export interface ToolCheckReport {
  ok:           boolean;
  /**
   * Whether a check actually RAN. It qualifies `ok`: `ok: true` with `checked: false` means nothing was
   * examined, not that the source is sound — an index that cannot type-check (the browser, which has no
   * TypeScript program) reports exactly that.
   *
   * Required, not optional, because the alternative is the failure this whole path is built to avoid: a
   * checker that reports success while checking nothing is indistinguishable from one that works, and a
   * caller recording "verified" off the back of it records something false.
   */
  checked:      boolean;
  /** Every finding, including those not detailed below — the number to report. */
  total:        number;
  /** The detailed findings, capped. */
  diagnostics:  ToolCheckDiagnostic[];
  /** Present only when the cap hid some, tallied by the same `label` the detailed ones carry. */
  omitted?:     { count: number; byLabel: Record<string, number> };
}

/**
 * A {@link ToolCheckReport} as the text an author — usually a model repairing its own code — reads:
 * each finding's annotated block, then the overflow summary as a TRAILING LINE.
 *
 * Here rather than in the checker because two packages render one report: the node checker that
 * produces it, and any consumer that must put it in front of whoever wrote the code. The overflow line
 * is the reason it is worth sharing at all — appending it to the findings ARRAY instead is exactly the
 * bug this shape exists to prevent, and one renderer is one place for that to stay true.
 */
export function renderToolCheck(report: ToolCheckReport): string {
  const parts = report.diagnostics.map(d => d.rendered);
  if (report.omitted !== undefined) parts.push(renderToolCheckOmitted(report.omitted));
  return parts.join('\n');
}

/** The overflow summary alone — one line, for a consumer laying the findings out itself. Separate so it
 *  can be had without rendering every finding in order to keep the last line of the result. */
export function renderToolCheckOmitted(omitted: NonNullable<ToolCheckReport['omitted']>): string {
  const tally = Object.entries(omitted.byLabel).map(([l, n]) => `${l}×${n}`).join(', ');
  // The cascade advice is about tsc's own errors: a cast-gate finding is a structural rule fired at one
  // site, cascades from nothing, and inviting a reader to expect it to vanish with the first fix is what
  // would get it ignored.
  const cascade = Object.keys(omitted.byLabel).some(l => l.startsWith('TS'))
    ? ' — likely cascading from the errors above.' : '';
  return `…plus ${omitted.count} more: ${tally}${cascade}`;
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
   *  params) is in scope. Returns a {@link ToolCheckReport} whose positions are snippet-relative. A
   *  composer uses it to catch bad tool-call code before running/registering it. */
  check(snippet: string): Promise<ToolCheckReport>;
  /** Per live tool (that has a contract): the `params`/`result` wire text, flattened from the one contract —
   *  a source tool's `ToolContracts` arms (via the source scan) or a source-less tool's `toolContract` string.
   *  The single contract is thus also the source of the wire description; the host folds this into the
   *  outgoing tool descriptions at the turn's dispatch edge. A tool with only a loose `inputSchema` (no
   *  contract) is absent. */
  wireContracts(): Promise<Record<string, { params: string; result: string }>>;
}
