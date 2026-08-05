import type { FileHandle, FileStore } from './files.js';
import type { FormField, MessageContent, Session } from './messages.js';
import type { MatbotPlugin } from '../plugin.js';
import type { JSONSchema } from './primitives.js';
import type { Vault } from './vault.js';

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * Media a tool hands to the model to *look at*, as opposed to the JSON it reads as a `result`. The
 * inline arms of {@link MessageContent} — bytes plus a mime type, carrying their own meaning with no
 * dependency on anything that could resolve a reference. Where the tool got the bytes (a `FileStore`,
 * an HTTP fetch, a chart rendered in memory) is entirely the tool's business; the harness never asks.
 */
export type ModelContent = Extract<MessageContent, { type: 'image' | 'document' | 'audio' }>;

export type ToolEvent<Result = unknown> =
  | { type: 'stdout';   chunk: string }
  | { type: 'stderr';   chunk: string }
  | { type: 'progress'; pct: number; message?: string }
  | { type: 'result';   value: Result }
  | { type: 'file';     handle: FileHandle }
  // Media for the model's eyes, pinned to this tool call's result and carried on the wire for the
  // REST OF THIS TURN only — never persisted. Independent of `result`: the durable record of what the
  // tool did is its `result`, and a transcript that re-reads clean is the point. A later turn that
  // needs the bytes again calls the tool again, which is the same pull the model already performed.
  //
  // Rest-of-turn rather than next-call-only because withdrawing content the model has already seen
  // mid-history breaks the prompt cache from that point and leaves it referring to something no longer
  // there. The corollary is cost: a large document is re-sent on every subsequent round of the turn,
  // so a tool should hand over the smallest thing that answers the question (a page range, a thumbnail)
  // and `maxRounds` is the ceiling on how often it is paid for.
  | { type: 'model-content'; content: ModelContent[] }
  // A durable, LLM-invisible annotation the tool emits as it runs (a link, a status, a trace of a
  // side-effect). Persisted as a `marker`-role message; elided from provider submission like any
  // marker. Independent of `result` — a tool may emit markers and no result (a silent side-effect,
  // e.g. a trigger-fired tool), a result and no markers, or both.
  | { type: 'marker';   creator: string; data: unknown }
  | { type: 'error';    message: string; code?: number; stdout?: string; stderr?: string };

/**
 * Per-tool call-contract registry: maps a tool's `name` to a {@link ToolContract} arm (or a union of
 * them) pairing the `value` it yields in its `result` event with the params that produce it. Augment it
 * exactly like {@link MarkerData} / `MatbotServices`, so a caller gets the concrete result type back
 * from {@link invokeTool} + `toolResult` instead of `unknown`:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface ToolContracts {
 *       find_fact: ToolContract<string[] | null, { question: string; terms: { term: string }[] }>;
 *     }
 *   }
 *
 * The tool name is the discriminator: `invokeTool(machine, 'find_fact', …)` is typed
 * `AsyncIterable<ToolEvent<string[] | null>>`, so `toolResult(…)` resolves to `string[] | null`. A
 * name with no registered entry resolves to `unknown` (the caller must narrow). This is a pure
 * type-level construct — no runtime validation; it pins, at the call site, the contract a tool's
 * executor already produces. Keep the entry in sync with what the executor actually yields.
 *
 * Even a single-action tool declares an **arm**, never a bare `name: Result`. The bare form still
 * type-checks — `ToolResultOf`/`ToolResultFor` keep a plain-entry path so an unregistered or foreign
 * tool stays loose — but it carries no params, so {@link ToolProxy} derives no call signature from it
 * and `await tool.find_fact(…)` is uncallable.
 *
 * **Multi-action tools** are a weird form of overloaded function: the same tool returns different
 * shapes depending on its params. Register such a tool as a union of {@link ToolContract} *arms*, each
 * pairing a result with the discriminating params *pattern* that selects it — `invokeTool` matches the
 * call's literal params against the patterns and narrows the result to the matching arm:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface ToolContracts {
 *       session_action:
 *         | ToolContract<Session,                       { action: 'get' }>
 *         | ToolContract<{ id: string; title: string }, { action: 'rename' }>;
 *     }
 *   }
 *   // invokeTool(machine, 'session_action', { action: 'get', sessionId }) → result is Session
 *
 * The pattern is *any* discriminating field(s), not just `action` (a tool keying on `interval`'s
 * presence registers `ToolContract<…, { interval: string }>`). It is a *pattern*, not the full input:
 * key only on the discriminant so a call carrying just that field still matches. When no arm's pattern
 * matches (a non-literal discriminant, or an absence-discriminant the positive patterns can't express),
 * the result falls back to the union of every arm — always sound, just less narrow.
 *
 * One of matbot's five open-registry augmentation points — same technique at each; see
 * docs/DEVELOPING.md *Open-registry augmentation* for the shared shape and the rules that follow from it.
 */
export interface ToolContracts {}

// Phantom carriers for ToolContract's two parameters. `unique symbol` keys rather than `__result`/`__args`
// so the type is *uninhabitable*: a plugin author cannot name these keys, so no value of ToolContract can
// be written down by accident (or on purpose, to smuggle a shape past the checker) — where the previous
// `__`-prefixed properties were merely conventionally-private and constructible with a couple of casts.
// A cast is the one hole through which a hallucinated result shape survives to runtime, which is why the
// generated-code checker closes it deterministically; this closes the same hole in the type itself.
declare const RESULT: unique symbol;
declare const ARGS:   unique symbol;

/**
 * One overload arm of a multi-action tool registered in {@link ToolContracts}: the `Result` it yields
 * for a call whose params match the discriminating pattern `Args`. `Args` defaults to `unknown` (an
 * arm that matches any params). Purely type-level — the fields below are phantom and uninstantiable.
 */
export interface ToolContract<Result, Args = unknown> {
  readonly [RESULT]: Result;
  readonly [ARGS]:   Args;
}

type ToolResultArmed<E>           = E extends ToolContract<unknown, unknown> ? true : false;
type ToolResultUnion<E>           = E extends ToolContract<infer R, unknown> ? R : never;
type ToolResultMatched<E, P>      = E extends ToolContract<infer R, infer A> ? (P extends A ? R : never) : never;

/** The full set of `result` values a tool named `K` may yield — the union over all its arms (for an
 *  arm-based entry), the entry itself (for a plain entry), or `unknown` when `K` is unregistered. This
 *  is what an executor binds against (`ToolExecutor<ToolResultOf<'my_tool'>>`): it must cover every arm. */
export type ToolResultOf<K extends string> =
  K extends keyof ToolContracts
    ? ToolResultArmed<ToolContracts[K]> extends true ? ToolResultUnion<ToolContracts[K]> : ToolContracts[K]
    : unknown;

/** The `result` a call to tool `K` with params `P` yields: for an arm-based entry, the arm whose
 *  pattern `P` matches (or the full union when none match — always sound); otherwise {@link ToolResultOf}. */
export type ToolResultFor<K extends string, P> =
  K extends keyof ToolContracts
    ? ToolResultArmed<ToolContracts[K]> extends true
      ? ([ToolResultMatched<ToolContracts[K], P>] extends [never]
          ? ToolResultUnion<ToolContracts[K]>
          : ToolResultMatched<ToolContracts[K], P>)
      : ToolContracts[K]
    : unknown;

// Distribute a union to its intersection: `A | B` → `A & B`. An intersection of function types is an
// overload set, so this turns a union of per-arm call signatures into an overloaded function.
type UnionToIntersection<U> =
  (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

// One `ToolContracts` arm → its call signature. A fully-untyped arm (`ToolContract<unknown, unknown>`, the
// fallback for a foreign/MCP tool carrying only a JSON-Schema `inputSchema`) keeps a loose, optional-param
// signature so it stays callable; a typed arm requires its declared params.
type ArmCallSig<E> =
  E extends ToolContract<infer R, infer P>
    ? (unknown extends P ? (params?: unknown) => Promise<R> : (params: P) => Promise<R>)
    : never;

// The union of a tool's arm params — the parameter type of the trailing catch-all signature below.
type ArmArgsUnion<E> = E extends ToolContract<unknown, infer A> ? A : never;

/**
 * The type of the injected `tool` proxy that `function-tools` and compiled skills call
 * (`await tool.name(params)`). Each key is derived from its {@link ToolContracts} entry: a multi-arm
 * (multi-action) entry becomes an **overload set** — one `(params) => Promise<result>` signature per arm —
 * so `await tool.name(params)` narrows its result by the params passed, exactly the contract a code
 * generator needs to write a correct call first time. A single-arm entry is one signature. This is what the
 * generated `dts()` declares `tool` as; it is *derived* — never hand-authored — from the same `ToolContracts`
 * augmentation that types authors' `invokeTool`/`toolResult` calls, so the human editor and the LLM see one
 * source of truth.
 *
 * The trailing catch-all signature (params union → result union) exists for soundness at the *meta-type*
 * level, not for call sites: overload resolution is first-match, so a well-formed call still hits its
 * specific arm and narrows precisely, and a malformed call matches nothing and still errors. What it
 * changes: `ReturnType<typeof tool.x>` — which on a bare overload set resolves to an arbitrary (last) arm,
 * a real-world codegen trap — now degrades to the sound full union; and a params value typed as a union of
 * arms (dynamic multi-action dispatch) becomes callable, returning the result union.
 */
export type ToolProxy = { [K in keyof ToolContracts]:
    UnionToIntersection<ArmCallSig<ToolContracts[K]>>
  & ((params: ArmArgsUnion<ToolContracts[K]>) => Promise<ToolResultUnion<ToolContracts[K]>>) };

/**
 * Ask the user a question and resolve with their answer. The host supplies the
 * implementation — readline in the CLI, an SSE round-trip in the web frontend. This is
 * matbot's single mechanism for eliciting user input at runtime; it is injected both into
 * tool execution (`ToolContext.prompt`) and into plugin loading (collision resolution in setup).
 *
 * Two call forms:
 *   - `(question, defaultValue?)` — free text; resolves to the typed string (or the default).
 *   - `(field: FormField)` — a single structured field (`select`/`confirm`/`password`/`text`),
 *     letting rich frontends render real controls (buttons, masked input). Frontends that can't
 *     render it fall back to `field.label` as plain text. Resolves to the chosen/typed value.
 *
 * Cancellation is the "we can't proceed — give up" path (distinct from a graceful "decline", which
 * is simply one of the offered `options`). The host rejects the promise with `PromptCancelledError`
 * and abandons the current turn, returning to idle; a caller's surrounding try/catch turns the
 * rejection into a tool error that closes the tool call cleanly.
 *     This reuses `FormField` rather than a parallel type; it is a one-shot request/response and
 *     deliberately does NOT engage the session-bound `form`/`form-response` flow.
 */
export interface PromptFn {
  (question: string, defaultValue?: string): Promise<string>;
  (field: FormField): Promise<string>;
}

export interface ToolContext {
  callId:      string;
  session:     Session;
  signal:      AbortSignal;
  vault:       Vault;
  /** The provider key driving the current turn (`RunConfig.provider`). A tool that spawns further
   *  work should default to this so the child inherits the same model rather than the config default. */
  provider?:   string;
  workdir?:    string;
  configPath?: string;
  files?:      FileStore;
  /** Prompt the user for input. The host provides a readline or form implementation. */
  prompt:      PromptFn;
  /** Hot-load a plugin by specifier without restarting the process. Returns the loaded plugin.
   *  `refresh` (default false) forces a remote (github/http) plugin to be re-downloaded rather than
   *  re-loaded from its `.plugins/` cache — pass true to pick up changed upstream source. */
  loadPlugin(specifier: string, refresh?: boolean): Promise<MatbotPlugin>;
  /**
   * Hot-unload a plugin by specifier, removing its tools, hooks, and system context contributions.
   * Resolves `true` if a plugin was actually resident and unloaded, `false` if there was nothing
   * to unload. A failed `teardown()` (e.g. timeout) still throws — the plugin was resident in that case.
   */
  unloadPlugin(specifier: string): Promise<boolean>;
}

/**
 * The read-only facts about the call a composed function is running under, injected into a
 * `tool_function` body as the ambient `context` binding beside `tool`/`toolInContext`. Deliberately
 * narrower than {@link ToolContext}: the identity of the call, not its capabilities — `vault`,
 * `files`, `prompt` and plugin (un)loading stay off a surface authored by a model and reachable only
 * through the tool contracts. A tool with real source takes `ToolContext` and needs none of this.
 *
 * Not `ToolCallContext` — that name belongs to the `toolcall` hook's context; this is the composed
 * caller's own view, not a hook's view of a call about to run.
 */
export interface ComposedCallContext {
  readonly callId:    string;
  readonly sessionId: string;
  /** The provider key driving the turn — the same one nested `tool.x(…)` calls inherit. */
  readonly provider?: string;
  readonly workdir?:  string;
  readonly signal:    AbortSignal;
}

/**
 * A tool's runtime. `R` is the type of the `value` carried by its `result` event — declared once,
 * at the source, so the executor's yields and the tool's {@link ToolContracts} registry entry can't
 * silently drift. The `unknown` default keeps untyped executors compiling untouched, and covariance
 * means a narrower `ToolExecutor<X>` still satisfies `ToolExecutor` (i.e. `ToolExecutor<unknown>`),
 * so the heterogeneous registry boundary (`Tool[]`) accepts any executor. Bind `R` to the registry
 * entry with `ToolExecutor<ToolResultOf<'my_tool'>>` so the single augmentation is the source of truth.
 */
export interface ToolExecutor<R = unknown> {
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent<R>>;
}

export interface Tool<R = unknown> {
  name:         string;
  description:  string;
  inputSchema:  JSONSchema;
  /** The call contract as TypeScript source — a {@link ToolContract}`<Result, Params>` (or a union of arms
   *  for a multi-action tool), *identical in shape* to what a `ToolContracts` augmentation declares. Only a
   *  tool with **no scannable source** carries this — a `function-tools` function (whose signature supplies
   *  both halves), and any similarly runtime-defined tool: the host splices it verbatim into the generated
   *  dts's `ToolContracts`, and derives the wire `params`/`result` text from it. A tool WITH source declares
   *  its contract as a `ToolContracts` augmentation instead and omits this. Foreign tools (e.g. MCP proxies)
   *  that have neither fall back to the loose `inputSchema`. */
  toolContract?: string;
  executor:     ToolExecutor<R>;
  pluginName?:  string;
}
