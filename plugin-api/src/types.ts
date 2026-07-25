import type { MatbotPlugin } from './plugin.js';
import type { StoreQuery, QueryResult } from './store-query.js';

// ── Primitives ────────────────────────────────────────────────────────────────

export type ISODate = string;
export type MimeType = string;
export type JSONSchema = Record<string, unknown>;

// ── Principal ───────────────────────────────────────────────────────────────

/** Identity of whatever initiated an operation — a turn, a tool call, a store read/write.
 *  Established at each entry point and carried ambiently via the `PrincipalCarrier`
 *  (`currentPrincipal()` / `runAs()`), so any layer can attribute or test the origin without it
 *  being threaded through every signature. It grants nothing — policy is the service's concern. */
export interface Principal {
  id:    string;
  type:  'user' | 'agent' | 'system';
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface ModelParameters {
  temperature?:    number;
  maxTokens?:      number;
  topP?:           number;
  stopSequences?:  string[];
  [key: string]:   unknown;
}

export interface ProviderConfig {
  name:         string;
  /** Plugin module specifier (npm name or file URL) that provides the adapter for this provider. */
  module:       string;
  model:        string;
  credentials?:  Record<string, string>;
  endpoint?:    string;
  parameters?:  ModelParameters;
  fallback?:    string;
}

/**
 * Token (and optional cost) counters for one provider call — pure accounting data, never conversation
 * content. Recorded onto the message stream for cost reckoning but elided from provider submission. The
 * producing provider is recorded alongside at each storage site (an assistant turn carries it on the
 * message's `providerName`; a tool-invoked completion pairs it explicitly — see `tool-result`), since a
 * tool may run a completion against any configured provider, each with its own rates.
 */
export interface Usage {
  inputTokens:          number;
  outputTokens:         number;
  costUsd?:             number;
  cacheReadTokens?:     number;
  cacheCreationTokens?: number;
}

/** One provider call's usage, tagged with the provider billed — the unit a tool accrues (a tool may
 *  run completions against any provider, each with its own rates) and the element persisted on a
 *  `tool-result`'s `usage` addendum. See the ambient usage carrier (`recordUsage`/`currentUsageSink`). */
export interface UsageRecord {
  provider: string;
  usage:    Usage;
}

/**
 * Opaque, provider-specific round-trip metadata attached to a tool-call — captured from a completion,
 * persisted, and re-sent verbatim when the call is replayed in history (e.g. a Gemini 3 "thought
 * signature", which every historical `functionCall` must carry or the request 400s). The harness never
 * interprets it: it stores, renders, or elides it. Empty by default — a provider package augments its
 * OWN slice from its own module (namespaced by provider family, so slices from different providers in a
 * mixed-provider session never collide), so adding a provider that needs round-trip state touches NO
 * core code:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface ProviderMeta { google?: { thoughtSignature?: string } }
 *   }
 *
 * A single session interleaves tool-calls from many providers, so this must be an open, additive union
 * (interface augmentation) — a generic type parameter can bind only one provider per instantiation and
 * so could not type a heterogeneous transcript.
 */
export interface ProviderMeta {}

export type CompletionEvent =
  | { type: 'text-delta';          delta: string }
  | { type: 'tool-call';           id: string; name: string; input: unknown;
      /** Provider-specific round-trip metadata for this call, opaque to the harness — see `ProviderMeta`. */
      meta?: ProviderMeta }
  | { type: 'tool-result';         id: string; result: unknown }
  | { type: 'thinking';            delta: string }
  | { type: 'thinking-block';      thinking: string; signature: string }
  | { type: 'redacted-thinking';   data: string }
  | { type: 'reasoning-block';     reasoning: string }
  | { type: 'refusal';             text: string }
  | { type: 'unknown-block';       blockType: string; raw: unknown }
  | ({ type: 'usage' } & Usage)
  | { type: 'done' };

export interface ProviderAdapter {
  readonly name: string;
  complete(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal
  ): AsyncIterable<CompletionEvent>;
  health(): Promise<HealthStatus>;
}

// ── Messages & Session ────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'marker';

export type MessageContent = (
  | { type: 'text';              text: string }
  | { type: 'thinking';          thinking: string; signature: string }
  | { type: 'redacted-thinking'; data: string }
  | { type: 'reasoning';         reasoning: string }
  | { type: 'image';             data: string; mimeType: MimeType }
  | { type: 'image-url';         url: string; detail?: 'low' | 'high' | 'auto' }
  | { type: 'document';          data: string; mimeType: MimeType; name?: string }
  | { type: 'audio';             data: string; mimeType: MimeType }
  | { type: 'tool-call';         id: string; name: string; input: unknown;
      /** Provider-specific round-trip metadata, persisted and re-sent verbatim on replay — see
       *  `ProviderMeta` and the `tool-call` `CompletionEvent`. */
      meta?: ProviderMeta }
  | { type: 'tool-result';       id: string; result: unknown; isError?: boolean;
      /**
       * Accounting addendum: completions the tool itself ran (e.g. `single_turn`, `dream_time`'s ranker/
       * merger), captured ambiently via the usage carrier and recorded for cost reckoning. Elided from
       * provider submission — adapters serialise only `id`/`result`/`isError`. One entry per provider
       * call, each tagged with the provider billed; never summed at write time, as rates differ.
       */
      usage?: UsageRecord[] }
  | { type: 'refusal';           text: string }
  | { type: 'file-ref';          fileId: string; name: string; mimeType: MimeType }
  | { type: 'form';              fields: FormField[]; submitLabel?: string }
  | { type: 'form-response';     values: Record<string, string> }
  | { type: 'marker';            creator: string; data: unknown }
  | { type: 'unknown-content';   blockType: string; raw: unknown }
) & {
  /**
   * Authorship provenance, for *presentation only* — orthogonal to the message's `role`, which is
   * the LLM-protocol identity. Absent ⇒ authored per the role (a human for `user`, the model for
   * `assistant`). `'robo'` ⇒ machine-authored by matbot — a `followup` resubmission, or a hook-
   * injected fragment inside a human turn. It is still carried to the model as ordinary
   * role-appropriate content (the model sees a `user` block either way); the flag is OOB metadata
   * that frontends use to present it agent-side (a robot indicator) rather than as the user's words.
   */
  origin?: 'robo';
};

/**
 * A marker is opaque, durable annotation carried in the message stream: links, status,
 * cross-references that are meaningful to a frontend but transparent to the LLM. They are
 * persisted unchanged, elided from provider submission, and deliberately preserved by
 * session compaction (removing one can break things — e.g. a pointer back to an ancestor
 * session). Any code with session access may emit one, normally as its own message.
 *
 * `creator` is the emitting plugin's reference; `data` is anything serialisable. For
 * per-creator type safety, augment `MarkerData` and read/write via `Marker<'your-creator'>`:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface MarkerData { 'split-session': { peerSessionId: string } }
 *   }
 *
 * Unregistered creators fall back to `data: unknown`. The base `MessageContent` member stays
 * loose (`creator: string`) so the union and its exhaustive switches are unaffected.
 */
export interface MarkerData {
  /** Emitted by the hook dispatcher when a hook handler threw: the hook was skipped (treated as a
   *  no-op) and this records it once, so a misconfigured/throwing hook degrades visibly instead of
   *  bricking the turn. `channel` is the hook point, `pluginName` the owning plugin if known. */
  'matbot-hooks': { channel: HookPoint; pluginName?: string; message: string };
}

export type Marker<K extends string = string> = {
  type:    'marker';
  creator: K;
  data:    K extends keyof MarkerData ? MarkerData[K] : unknown;
};

export interface FormField {
  name:        string;
  label:       string;
  type:        'text' | 'password' | 'select' | 'confirm';
  options?:    string[];
  /** select-only: render an "Other…" affordance that lets the user type a free-form answer instead
   *  of picking an option. The typed value is returned verbatim, on the same channel as a pick —
   *  callers never learn whether the answer was a preset or free text. Ignored for other types. */
  allowOther?: boolean;
  default?:    string;
  required?:   boolean;
  /** Presentation hint only (default true): whether the frontend offers a cancel affordance (the
   *  "give up" path — see `PromptFn`). Set false to render a hard-blocking prompt with no out. The
   *  runner and server never consult this; a frontend with no cancel UI simply can't fire one. */
  cancelable?: boolean;
}

/**
 * Canonical values a `type: 'confirm'` prompt resolves to. The rendered label and buttons are a
 * cosmetic, host-specific concern (and may be localised), so consumers MUST branch on these tokens
 * — never on the displayed string. Compare case-insensitively to tolerate host casing differences.
 */
export const CONFIRM_YES = 'yes';
export const CONFIRM_NO  = 'no';

export interface Message {
  id:            string;
  role:          MessageRole;
  content:       MessageContent[];
  createdAt:     ISODate;
  traceId:       string;
  providerName?: string;
  /** Token/cost accounting for the provider call that produced this message (assistant turns). The
   *  billed provider is this message's `providerName`. Accounting only — elided from provider submission. */
  usage?:        Usage;
  metadata?:     Record<string, unknown>;
}

export type SessionStatus = 'active' | 'archived' | 'pinned';

export interface Session {
  id:                    string;
  version:               string;
  // Legacy: persisted sessions may still carry `ownerPrincipalId` / `actorPrincipalId` / `persona`.
  // They were never read — ownership-at-rest is structural (the storage partition), resolved via the
  // backend, not a field. Left undeclared; old data keeps them harmlessly as excess properties.
  title?:                string;
  status:                SessionStatus;
  contexts:              string[];
  messages:              Message[];
  parentSessionId?:      string;
  branchPointMessageId?: string;
  createdAt:             ISODate;
  updatedAt:             ISODate;
}

// ── System context ────────────────────────────────────────────────────────────

export type SystemContextContributor = (ctx: {
  session:   Session;
  signal:    AbortSignal;
}) => string | null | Promise<string | null>;

export interface SystemContextRegistry {
  register(contributor: SystemContextContributor, pluginName?: string): void;
  removeByPlugin(pluginName: string): void;
  /** Calls all contributors and joins non-null, non-empty results with double newlines. */
  build(ctx: { session: Session; signal: AbortSignal }): Promise<string | null>;
}

// ── Pipeline hooks ────────────────────────────────────────────────────────────

export interface RunConfig {
  provider:   string;
  sessionId?: string;
  traceId?:   string;
}

/**
 * Hooks are sorted by the *job* they do, not by lifecycle position — the channel name is the
 * contract. Each channel has a fixed home, cadence, and effect-ceiling (a hook may always do
 * less: returning nothing makes it a pure observer). The discriminated union on `on` is what
 * keeps the effects honest — `contribute` hands you a read-only session, `toolcall`/`react` can't
 * return one at all, so a write that goes nowhere won't type-check.
 *
 *   screen      runner, once per turn before the first provider call. The only channel that may
 *               durably mutate history. Returns any of: a replacement `session` (persisted),
 *               turn-scoped `ephemeral` context (appended onto the tail of this turn's outgoing
 *               messages — the freshest input the model reads — never persisted, and placed at the
 *               tail rather than a system prefix so a "do X now" directive keeps its salience and
 *               doesn't bust the cached prefix), `durable` context (the persisted, visible twin of
 *               `ephemeral`: folded onto this turn's user message as `origin: 'robo'` blocks and
 *               carried live as a `robo-user` event, so it survives into the next turn's history),
 *               or `abort`. Mix freely. This is where the durable-vs-ephemeral choice for incoming
 *               user input lives.
 *   contribute  runner, before *every* provider call. Ephemeral by construction (it re-fires, so a
 *               durable mutation would accumulate). Returns a transformed copy of `outgoing` — the
 *               message array about to be sent — and never touches the stored session. Mind prompt
 *               caching: vary the *tail* (newest turn) freely, but a transform that rewrites the
 *               cached prefix (system / early history) busts the cache on every call.
 *   toolcall    runner, before each tool execution. Read-only. Returns `rejectTool` (skip this call,
 *               feed an error result back so the model self-corrects, without breaking the
 *               tool_use/tool_result pairing) and/or `abort`.
 *   toolresult  runner, after each tool execution, before the result is recorded/yielded. Folds the
 *               result through each hook: return `{ result }` to replace it (hard redaction, truncation),
 *               or nothing to observe (auditing — the context carries args, result, isError and
 *               `durationMs`). It owns the LLM-facing + persisted result and the `tool:end` event;
 *               note it does NOT see the live `tool:stdout/stderr` chunks, which stream before the
 *               result exists.
 *   followup    pump, once after a turn commits (post-persist). May `resubmit` a robo follow-up turn
 *               (head-enqueued, so it runs next as its own real turn; `resubmitDepth` is the chain
 *               length for the hook's own budget — the runner also hard-caps it), `retractAndRerun`
 *               (pop the committed turn into a marker and re-run the originating user turn with
 *               ephemeral context — supersede rather than follow), and/or append durable `markers`
 *               to the committed session (LLM-invisible annotations — the second durable-write point
 *               after `screen`, safe because it too fires once per turn).
 */
export type HookPoint = 'screen' | 'contribute' | 'toolcall' | 'toolresult' | 'followup';

export interface ScreenContext {
  session: Session;
  config:  RunConfig;
  signal:  AbortSignal;
  /** The turn's interactive prompt, when a frontend supplied one (a live user behind this turn).
   *  A hook that drives an interactive tool (e.g. a trigger invoking `ask_user`) forwards this into
   *  the tool's context; absent (cron/background/no frontend) the tool gets a rejecting prompt. */
  prompt?: PromptFn;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}
export interface ScreenResult {
  session?:   Session;
  /** Turn-scoped context appended onto the tail of this turn's outgoing messages (the freshest
   *  input the model reads), never persisted. At the tail, not a system prefix, so a directive
   *  keeps its salience and the cached system/history prefix stays stable across turns. */
  ephemeral?: MessageContent[];
  /**
   * The persisted, visible twin of `ephemeral`: context that should outlive this turn rather than
   * inform it once. The runner folds these blocks onto this turn's user message (so they ride into
   * the stored history and every subsequent provider call) AND carries them live as a `robo-user`
   * event, so a live draw and a reload render the same thing. They are LLM-visible (unlike
   * `markers`) and machine-authored, so a caller marks them `origin: 'robo'` for presentation.
   * Use when a fired hook produces context that genuinely updates the conversation, not a one-shot
   * corrective for the turn about to run.
   */
  durable?:   MessageContent[];
  /**
   * Durable `marker` blocks to append to this turn's session (LLM-invisible). The dispatcher both
   * appends them to the persisted session AND carries them live on the turn's event stream, so a
   * live draw and a reload render the same thing. Use instead of hand-appending to `session` when
   * you just want to annotate (e.g. a fired trigger's silent tool recording what it did).
   */
  markers?:   MessageContent[];
  abort?:     string;
}

export interface ContributeContext {
  readonly outgoing: readonly Message[];
  readonly session:  Session;
  config:  RunConfig;
  signal:  AbortSignal;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}

export interface ToolCallContext {
  readonly session:  Session;
  readonly toolCall: { id: string; name: string; input: unknown };
  readonly tool:     Tool;
  config:  RunConfig;
  signal:  AbortSignal;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}
export interface ToolCallResult {
  rejectTool?: { message: string };
  abort?:      string;
}

export interface ToolResultContext {
  readonly session:    Session;
  readonly toolCall:   { id: string; name: string; input: unknown };
  readonly tool:       Tool;
  readonly result:     unknown;
  readonly isError:    boolean;
  readonly durationMs: number;
  config:  RunConfig;
  signal:  AbortSignal;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}
// The toolresult hook returns `{ result }` to replace the tool's result, or nothing to leave it
// (and just observe) — a trivial single-field return, inlined in the Hook union like `contribute`'s.

export interface FollowupContext {
  readonly session:       Session;
  readonly resubmitDepth: number;
  config:  RunConfig;
  signal:  AbortSignal;
  /** The turn's interactive prompt, when a frontend supplied one (a live user behind this turn).
   *  A hook that drives an interactive tool (e.g. a trigger invoking `ask_user` as a proactive
   *  follow-up question) forwards this into the tool's context; absent (cron/background/no frontend)
   *  the tool gets a rejecting prompt. Note this prompt fires *post-commit*, out of band from the
   *  turn's `done`, and blocks the pump until the human answers. */
  prompt?: PromptFn;
  /** Unregister the hook currently running. For one-shot hooks that should fire at most once. */
  removeHook(): void;
}
export interface FollowupResult {
  resubmit?: { content: MessageContent[] };
  /**
   * Retract-and-rerun: supersede the just-committed turn instead of following it. The pump pops the
   * committed turn back to (and excluding) the last user message, stashes the popped content in a
   * durable retraction marker (LLM-elided like every marker, so a frontend can render it
   * struck-through and a post-mortem can audit it), then re-runs that same user turn with `context`
   * injected EPHEMERALLY (tail-folded, never persisted) — agent-phase injection time-shifted onto a
   * committed turn. This is the inverse of `resubmit`, which leaves the response in place and appends
   * a new robo turn after it. Self-terminating by design: a well-formed trigger fires on a *curable*
   * defect that the injected context dissolves on the redo, so it won't re-fire; `resubmitDepth` (a
   * redo carries parent+1) caps an ill-formed one. `resubmit` and `retractAndRerun` are independent
   * capabilities — a single turn returning both is not expected, but both head-enqueue if it does.
   */
  retractAndRerun?: { context: MessageContent[] };
  /**
   * Durable `marker` blocks to append to the just-committed session (LLM-invisible; for tracing /
   * cross-references). The second durable-write capability after `screen` — safe here for the same
   * reason: `followup` fires once per turn, so an append can't accumulate the way a per-call channel
   * would. The pump persists them AND emits them live (post-commit, like a `queued` event) so a live
   * draw matches a reload. Use for recording what a post-commit reaction (e.g. a fired trigger's
   * silent tool) actually did.
   */
  markers?: MessageContent[];
}

export type Hook =
  | { on: 'screen';     priority?: number; pluginName?: string; handler(ctx: ScreenContext):     ScreenResult | void | Promise<ScreenResult | void> }
  | { on: 'contribute'; priority?: number; pluginName?: string; handler(ctx: ContributeContext): Message[]    | void | Promise<Message[]    | void> }
  | { on: 'toolcall';   priority?: number; pluginName?: string; handler(ctx: ToolCallContext):   ToolCallResult | void | Promise<ToolCallResult | void> }
  | { on: 'toolresult'; priority?: number; pluginName?: string; handler(ctx: ToolResultContext): { result: unknown } | void | Promise<{ result: unknown } | void> }
  | { on: 'followup';   priority?: number; pluginName?: string; handler(ctx: FollowupContext):   FollowupResult | void | Promise<FollowupResult | void> };

// ── Storage ───────────────────────────────────────────────────────────────────
// The query grammar (Filter AST, StoreQuery, QueryResult, StoreQueryError) lives in ./store-query.

export type CASResult<T> =
  | { ok: true;  doc: T }
  | { ok: false; current: T | null };

export interface Store<T extends { id: string; version: string }> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  cas(id: string, expected: string, next: T): Promise<CASResult<T>>;
  delete(id: string, expectedVersion?: string): Promise<boolean>;
  query(q: StoreQuery): Promise<QueryResult<T>>;
}

// ── Knowledge index ───────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id:           string;
  version:      string;
  entities:     string[];
  tags:         string[];
  summary:      string;
  content:      string;
  contentHash?: string;
  source:       { type: string; uuid: string };
  confidence?:  number;
  createdAt:    string;
  updatedAt:    string;
}

export interface KnowledgeIndex {
  index(entry: KnowledgeEntry): Promise<void>;
  /** Remove the entry with this id, if present (idempotent — removing an absent id is a no-op). The
   *  id is the index's sole primary key (`index` replaces by it), so retraction is by id alone; the
   *  index never inspects an entry's opaque `source`. The party that indexed an entry owns retracting
   *  it — e.g. a skill manager retracts a hidden/deleted skill rather than the index policing tenants. */
  remove(id: string): Promise<void>;
  search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]>;
  /** Enumerate all indexed entries. When present, register('KnowledgeIndex', …) drains these into the incoming backend. */
  entries?(): Iterable<KnowledgeEntry>;
}

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

// ── Tools ─────────────────────────────────────────────────────────────────────

export type ToolEvent<Result = unknown> =
  | { type: 'stdout';   chunk: string }
  | { type: 'stderr';   chunk: string }
  | { type: 'progress'; pct: number; message?: string }
  | { type: 'result';   value: Result }
  | { type: 'file';     handle: FileHandle }
  // A durable, LLM-invisible annotation the tool emits as it runs (a link, a status, a trace of a
  // side-effect). Persisted as a `marker`-role message; elided from provider submission like any
  // marker. Independent of `result` — a tool may emit markers and no result (a silent side-effect,
  // e.g. a trigger-fired tool), a result and no markers, or both.
  | { type: 'marker';   creator: string; data: unknown }
  | { type: 'error';    message: string; code?: number; stdout?: string; stderr?: string };

/**
 * Per-tool result-type registry: maps a tool's `name` to the type of the `value` it yields in its
 * `result` event. Augment it exactly like {@link MarkerData} / `MatbotServices`, so a caller gets the
 * concrete result type back from {@link invokeTool} + `toolResult` instead of `unknown`:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface ToolContracts { find_fact: string[] | null }
 *   }
 *
 * The tool name is the discriminator: `invokeTool(machine, 'find_fact', …)` is typed
 * `AsyncIterable<ToolEvent<string[] | null>>`, so `toolResult(…)` resolves to `string[] | null`. A
 * name with no registered entry resolves to `unknown` (the caller must narrow). This is a pure
 * type-level construct — no runtime validation; it pins, at the call site, the contract a tool's
 * executor already produces. Keep the entry in sync with what the executor actually yields.
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
 */
export interface ToolContracts {}

/**
 * One overload arm of a multi-action tool registered in {@link ToolContracts}: the `Result` it yields
 * for a call whose params match the discriminating pattern `Args`. `Args` defaults to `unknown` (an
 * arm that matches any params). Purely type-level — the `__` fields are phantom and never constructed.
 */
export interface ToolContract<Result, Args = unknown> {
  readonly __result: Result;
  readonly __args:   Args;
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

// ── Files ─────────────────────────────────────────────────────────────────────

export interface FileMetaData {
  id:          string;
  version:     string;
  name:        string;
  mimeType:    MimeType;
  size:        number;
  createdAt:   ISODate;
  sessionId?:  string;
  messageId?:  string;
  namespace?:  string;
  /** Whether this file may be served at a public URL. Default-deny: absent ⇒ not servable. The
   *  flag rides in the file's own persisted metadata (no separate allow-list), so the same read that
   *  resolves a request also gates it. Producers opt in per put (the workspace tool sets it true). */
  allowed?:    boolean;
}

export interface FileHandle extends FileMetaData {
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export type FileEvent = FileMetaData & { changed: Array<keyof FileMetaData> };

/**
 * The generic, self-describing change envelope every partitioned CRUD stream emits (files, skills, and
 * future partitioned stores) — the payload half of a {@link Routed} event, whose `origin` carries the
 * acting principal/partition. It supersedes the per-stream bespoke shapes (the old `SkillEvent`, the raw
 * `FileEvent` on the wire) so a frontend firehose can filter and route every stream through ONE predicate.
 *
 * `namespace` is the ROUTING namespace the change lives under — `'files'`, `'skills'`, or a document
 * namespace — NOT a content sub-namespace (a file's own `metadata.namespace`, e.g. `'workspace'`, rides in
 * `detail`). Pairing `namespace` + `id` is exactly what `WatchVisibility.visible` needs to decide, per
 * connection, whether the viewer routes that item to the same partition (or has it shared in). `detail`
 * carries an optional rich payload for in-place UI updates — a file change ships its {@link FileMetaData}
 * so a sidebar row can update its size without a re-fetch; a skill change needs none (a refresh ping).
 */
export interface StoreChange {
  readonly operation: 'saved' | 'deleted';
  readonly namespace: string;
  readonly id:        string;
  readonly detail?:   unknown;
}

export interface FileFilter {
  sessionId?:     string;
  mimeType?:      string;
  namespace?:     string;
  createdAfter?:  ISODate;
  createdBefore?: ISODate;
}

export interface FileStore {
  /** Store a file. When `name` is provided, upserts by (name + namespace); otherwise always creates a new entry. */
  put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean }
  ): Promise<FileHandle>;
  get(id: string): Promise<FileHandle | null>;
  getByName(name: string, namespace?: string): Promise<FileHandle | null>;
  delete(id: string): Promise<void>;
  list(filter?: FileFilter): AsyncIterable<FileHandle>;
  putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle>;
  /** Observe file changes. Implementations that cannot watch their backing store omit this. */
  watch(signal?: AbortSignal): AsyncIterable<FileEvent>;
}

// ── Frontend ──────────────────────────────────────────────────────────────────

/**
 * Passed to `services.registerFrontend()` by a plugin declaring itself a frontend. A frontend
 * owns its own I/O (an HTTP server, a bot connection, a REPL); matbot only needs to know it
 * exists. This object is the growth point for frontend-level capability advertisement
 * (accepted/produced MIME types, size limits, …) as media support lands.
 */
export interface FrontendInfo {
  name: string;
}

// ── Vault ─────────────────────────────────────────────────────────────────────

/**
 * The primitives a vault backend must implement. Resolution, redaction, and the three
 * low-level store operations the smart `createSecret` policy composes. A backend implements
 * `Vault` (which is `VaultSpec` plus that policy); plugins are handed a `Vault`.
 */
export interface VaultSpec {
  /** Resolve ${NAME} placeholders by looking up the named value; throws MissingSecretError for any miss. */
  resolve(ref: string): Promise<string>;
  scrub(text: string): string;
  /**
   * Store `value` under exactly `name`, overwriting. The literal write; no reference/dedup logic.
   * An empty `value` removes the key instead — there is no such thing as an empty secret, so the
   * empty string is the removal signal (idempotent: removing an absent name is a no-op).
   */
  writeSecret(name: string, value: string): Promise<void>;
  /** Whether a secret is stored under this exact name. */
  hasKey(name: string): boolean;
  /**
   * The name a value is already stored under, if any. Optional: backends that can't (or won't)
   * reverse-index omit it, and `createSecret`'s dedup step is skipped.
   */
  findByValue?(value: string): string | undefined;
}

export interface Vault extends VaultSpec {
  /**
   * Store a secret coming (often) from a user via the LLM, where we cannot tell a real value
   * from a key name they typed by mistake. Returns the key name callers MUST reference — not
   * necessarily the `name` requested:
   *   - `value` is already a known key name → returns `value` (it was a reference, not a secret)
   *   - `value` already stored under another name → returns that name (dedup)
   *   - otherwise → writes under `name` and returns `name`
   */
  createSecret(name: string, value: string): Promise<string>;
}

// ── Health ────────────────────────────────────────────────────────────────────

export type HealthStatus =
  | { status: 'ok';       latencyMs?: number }
  | { status: 'degraded'; reason: string; latencyMs?: number }
  | { status: 'down';     reason: string };

// ── Registries ────────────────────────────────────────────────────────────────

export type ToolRegistryEvent =
  | { type: 'registered'; name: string; pluginName?: string }
  | { type: 'removed';    name: string };

export interface ToolRegistry {
  register(tool: Tool): void;
  remove(name: string): void;
  resolve(name: string): Tool | null;
  list(): readonly Tool[];
  removeByPlugin(pluginName: string): void;
  /** Observe tool CRUD as it happens. Read-only — observers cannot veto a registration. One event
   *  per tool (removeByPlugin emits a `removed` per matched tool). The stream ends when `signal` aborts. */
  watch(signal?: AbortSignal): AsyncIterable<ToolRegistryEvent>;
}

/** What the runner tells a {@link ToolPresenter} about the call it's about to make. */
export interface PresentContext {
  /** The session as of this provider call — the persisted user turn plus any assistant/tool turns
   *  taken so far this turn. A presenter ranks the tool set against this. */
  session:  Session;
  /** The provider profile name this turn runs under, so a presenter can tailor to provider
   *  capabilities (e.g. Anthropic's in-context tool_reference expansion). */
  provider: string;
}

/**
 * Chooses which tools are advertised to the model for a single provider call — a read-only *view* over
 * the turn's tool snapshot, NOT tool management. Presentation is orthogonal to the {@link ToolRegistry},
 * which stays the single source of registration, resolution, and type-contracts (its fragile, load-bearing
 * machinery is never a swap surface). The runner consults the presenter before *every* provider call, so
 * an impl may present a subset (deferring a large library behind a search tool) and grow it mid-turn as the
 * model discovers tools. Executor resolution is unaffected — a tool withheld here stays callable by name
 * through the live registry — so presentation only ever changes what the model is *told about*.
 *
 * Optional {@link MatbotServices} member (offer-loosely): absent ⇒ the runner advertises the whole
 * snapshot, byte-identical to today. `present` may return synchronously or async (a reranker).
 */
export interface ToolPresenter {
  present(tools: readonly Tool[], ctx: PresentContext): readonly Tool[] | Promise<readonly Tool[]>;
}

/**
 * The named provider profiles the runtime resolves by name. A `ReadonlyMap` for the many read-only
 * consumers (`services.providers.get`/`has`/`keys`/…), plus a sanctioned write path so a plugin can
 * *contribute* profiles live — a storage backend replaying provider definitions it captured in its own
 * medium, or the built-in `provider` tool — exactly as a plugin contributes tools via {@link ToolRegistry}.
 * Keyed by `config.name`; `register` upserts.
 */
export interface ProviderRegistry extends ReadonlyMap<string, ProviderConfig> {
  register(config: ProviderConfig): void;
  /** Explicit delete (the `provider` tool's `remove`) — removes the profile outright. */
  remove(name: string): boolean;
  /**
   * Undo a contribution: restore the boot-baseline profile for `name` if one existed (a plugin-supplied
   * profile that shadowed a configured one), otherwise delete it. A plugin that registers providers
   * (e.g. a storage backend replaying them from its medium) calls this for each in its `teardown()`, so
   * unloading it reverts the provider set to the host's boot condition — the multi-valued analogue of a
   * swap-member reverting to its captured boot default.
   */
  revert(name: string): void;
}

export type PluginRegistryEvent =
  | { type: 'loaded';   name: string }
  | { type: 'unloaded'; name: string };

// ── Pipeline events ─────────────────────────────────────────────────────────────

/**
 * The streaming output of a single turn. Every event carries the `traceId` of the turn that
 * produced it — that is the correlation key a frontend uses to route events to the right
 * message/bubble (see `SessionRunner`). A turn ends with exactly one terminal event:
 * `done` (completed), `aborted` (interrupted mid-flight), or `error`. `cancelled` is emitted
 * for a queued submission that was dropped before it ever ran (e.g. by `SessionRunner.abort`),
 * so it carries no session — there is nothing to persist.
 */
export type PipelineEvent =
  | { type: 'text-delta';     delta: string;          traceId: string }
  | { type: 'thinking';       delta: string;          traceId: string }
  | { type: 'tool:start';     callId: string; name: string; input: unknown; traceId: string }
  | { type: 'tool:stdout';    callId: string; chunk: string;  traceId: string }
  | { type: 'tool:stderr';    callId: string; chunk: string;  traceId: string }
  | { type: 'tool:progress';  callId: string; pct: number; message?: string; traceId: string }
  | { type: 'tool:end';       callId: string; result: unknown; isError: boolean; traceId: string }
  | { type: 'file';           handle: FileHandle;     traceId: string }
  | ({ type: 'usage';         traceId: string } & Usage)
  | { type: 'done';           session: Session;       traceId: string }
  | { type: 'aborted';        reason: string; session: Session; traceId: string }
  | { type: 'cancelled';      sessionId: string;      traceId: string }
  // Session-level (not turn-level, hence no traceId): the runner has fully drained its queue and is
  // now idle. Emitted once per busy period, *after* `running` flips false, so a consumer can map it
  // to an authoritative busy→idle transition without racing the internal state flip.
  | { type: 'idle';           sessionId: string }
  // A queued (not-yet-running) submission, carried on the stream so a frontend renders it as part
  // of the live "delta" (everything after the last committed message), never from stored state.
  // `queued` is the number of submissions ahead of it (0 ⇒ about to run). Emitted live on enqueue
  // and replayed (in queue order) to anyone subscribing mid-flight.
  | { type: 'queued';         content: MessageContent[]; queued: number; concatQueue: boolean; traceId: string; rootTraceId: string }
  // Machine-authored content folded onto the running turn's user message (a `screen` hook's
  // `durable` result — e.g. a fired `contextual` trigger), carried live so a frontend draws it
  // immediately. The blocks are already persisted in that user message (origin: 'robo'); this is
  // purely the live-delivery channel, so a live draw matches the reload (which splits the user
  // turn's robo blocks into their own agent-side bubble).
  | { type: 'robo-user';      content: MessageContent[]; traceId: string }
  // Marker blocks appended to the session this turn (e.g. the dispatcher's record of a hook that
  // threw), carried live so a frontend renders them without waiting for a session reload. The blocks
  // are already persisted in the session; this event is purely the live-delivery channel.
  | { type: 'marker';         content: MessageContent[]; traceId: string }
  | { type: 'error';          error: string;          traceId: string }
  | { type: 'system-context'; text: string;           traceId: string };

// ── Session runner ──────────────────────────────────────────────────────────────

/**
 * A view onto a session returned by `SessionRunner.open`. `session` is the authoritative
 * server-side state — committed messages plus an overlay of any queued-but-not-yet-run
 * submissions (each carrying `metadata.pending: true`). `events` is a lazy, per-session live
 * tap: accessing it subscribes to the turn event stream from now (replaying the in-flight
 * turn, if any); never touching it costs nothing.
 */
export interface SessionView {
  session:        Session;
  /** Submissions waiting behind the current turn (does not count the running turn). */
  queued:         number;
  /** Correlation id of the submission this call enqueued — present only when content was supplied. */
  traceId?:       string;
  readonly events: AsyncIterable<PipelineEvent>;
}

/** Observe a session without submitting anything. */
export interface OpenOpts {
  sessionId: string;
  signal:    AbortSignal;
  /** Optional caller-supplied correlation id; one is generated when absent. */
  traceId?:  string;
}

/** Observe a session AND enqueue a submission. The compiler enforces provider/principal here;
 *  a remote frontend deserializing a request body must still validate the wire input itself. */
export interface SubmitOpenOpts extends OpenOpts {
  content:      MessageContent[];
  provider:     string;
  principal:    Principal;
  /** When true, this submission may be merged with others drained in the same batch. Default false
   *  (queue mode: one turn per submission). */
  concatQueue?: boolean;
  /** Interactive prompt implementation for this submission's turn. The frontend owns delivery —
   *  it must target the frontend's per-session client connections, not a single request. */
  prompt?:      PromptFn;
}

/**
 * Serialises turns per session. A submission never executes concurrently with another for the
 * same session; the in-memory queue (lost on process restart, by design) absorbs anything that
 * arrives mid-turn. The server is the source of truth: a frontend renders whatever `open()`
 * returns and treats the live `events` stream purely as an optimisation.
 */
export interface SessionRunner {
  open(opts: OpenOpts | SubmitOpenOpts): Promise<SessionView>;
  /** Abort the running turn (if any) and drop all queued submissions, emitting `cancelled` for each. */
  abort(sessionId: string): void;
  /** Abandon the running turn (if any) WITHOUT touching the queue — `pump` advances to the next
   *  queued submission, or idles. The "give up on this turn" path (a prompt cancel); contrast
   *  `abort`, which also clears the queue. A no-op if nothing is running. */
  cancelTurn(sessionId: string): void;
  /** Snapshot of a session's live state: whether a turn is running and how many submissions wait
   *  behind it. `busy` is `running || queued > 0`. */
  status(sessionId: string): { busy: boolean; running: boolean; queued: number };
}
