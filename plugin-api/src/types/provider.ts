import type { HealthStatus } from './health.js';
import type { HookPoint } from './hooks.js';
import type { Message } from './messages.js';
import type { Tool } from './tools.js';

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
  /**
   * Ceiling on the agentic rounds one turn may take against this provider — a round being one provider
   * call plus the tool batch it asked for. Reaching it ends the turn (`aborted`, reason `round-limit`)
   * rather than starting another round. Absent ⇒ unbounded, which is the historical behaviour.
   *
   * It lives here, per provider, rather than as one global or a per-call override because that is the
   * unit spend is actually denominated in: a local model can afford to grind, a frontier model at 100×
   * the rate cannot, and the same deployment runs both. Not in `parameters` — those are forwarded to
   * the endpoint unmodified, and this never leaves matbot.
   */
  maxRounds?:   number;
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

/**
 * Where in matbot's own control flow a completion happened — the one accounting fact no adapter and no
 * plugin can recover after the fact, and therefore the one matbot must record. Everything derived from
 * it (what a tool costs, what a user costs, what a "task" costs) is a *grouping* of these coordinates
 * plus a rate table: policy, and a plugin's to own. See docs/ACCOUNTING-RATIONALE.md.
 *
 * Closed by construction: inside a turn there are exactly three places a completion can originate.
 * Outside a turn there is no scope at all, and accounting is the documented no-op.
 */
export type UsageSite =
  /** The runner's own provider call for one agentic round (1-based, as counted against `maxRounds`). */
  | { kind: 'round'; round: number }
  /** A completion run by a tool executor — `single_turn`, a ranker, a merger. */
  | { kind: 'tool';  callId: string; tool: string }
  /** A completion run by a hook handler — a trigger classifier, a router, an auto-compaction. */
  | { kind: 'hook';  channel: HookPoint; plugin?: string };

/** One provider call's usage, tagged with the provider billed — the unit a tool accrues (a tool may
 *  run completions against any provider, each with its own rates) and the element persisted on a
 *  `tool-result`'s `usage` addendum. See the ambient usage carrier (`recordUsage`/`currentUsageSink`). */
export interface UsageRecord {
  provider: string;
  usage:    Usage;
  /**
   * The call site in force when this was recorded, stamped by the producer rather than inferred by the
   * consumer. Absent only when a completion ran with no site established (a plugin reaching `complete`
   * outside any turn).
   *
   * Attribution is *declared*, not derived from timing, and that is the whole point: the triggers
   * classifier is kicked off detached inside a `screen` hook and resolves at an arbitrary later moment,
   * so any scheme that infers ownership from when a record lands (as slicing the sink by index did)
   * credits it to whichever tool happened to be running. Capturing the site where the work *starts*
   * makes that race unrepresentable.
   */
  site?:    UsageSite;
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
 *
 * One of matbot's five open-registry augmentation points — same technique at each; see
 * docs/DEVELOPING.md *Open-registry augmentation* for the shared shape and the rules that follow from it.
 */
export interface ProviderMeta {}

export type CompletionEvent =
  | { type: 'text-delta';          delta: string }
  | { type: 'tool-call';           id: string; name: string; input: unknown;
      /** Provider-specific round-trip metadata for this call, opaque to the harness — see `ProviderMeta`. */
      meta?: ProviderMeta;
      /**
       * Set when the call's arguments were severed mid-stream and never parsed — nearly always the
       * response hitting its token limit part-way through a large call. `input` is then `{}` (the wire
       * requires an object; the real arguments are unrecoverable), and the runner does NOT execute the
       * call: it pairs it with an error result saying so, exactly as it does a rejected one, and the
       * model self-corrects on the next round.
       *
       * Only adapters that accumulate arguments as a streamed JSON *string* can detect this — the
       * Anthropic (`input_json_delta`) and OpenAI (`function.arguments` fragments) shapes. Gemini
       * delivers each `functionCall` complete with `args` already an object, so there is nothing to
       * sever and the field is never set there.
       */
      truncated?: { bytes: number; stopReason?: string } }
  | { type: 'tool-result';         id: string; result: unknown }
  | { type: 'thinking';            delta: string }
  | { type: 'thinking-block';      thinking: string; signature: string }
  | { type: 'redacted-thinking';   data: string }
  | { type: 'reasoning-block';     reasoning: string }
  | { type: 'refusal';             text: string }
  | { type: 'unknown-block';       blockType: string; raw: unknown }
  /**
   * The response was cut short — the model did not choose to stop. `max-tokens` is the provider saying
   * so outright (`stop_reason: "max_tokens"` / `finish_reason: "length"` / `finishReason: "MAX_TOKENS"`);
   * `stream-end` is the stream ending with no finish reason at all, e.g. a dropped connection.
   *
   * Emitted whether or not a tool call was caught in it, because the far commoner case has no tool call
   * in it at all: prose stopping mid-sentence, which matbot previously did not surface anywhere. The
   * runner records it as a durable `matbot-truncation` marker — LLM-invisible, so it informs the reader
   * and the audit without the model narrating its own cut-off. Acting on it (continuing, re-asking with
   * a larger budget) is a `followup` hook's business, not the harness's.
   */
  | { type: 'truncated';           reason: 'max-tokens' | 'stream-end'; raw?: string }
  | ({ type: 'usage' } & Usage)
  | { type: 'done' };

/**
 * The result the runner records for a tool call whose arguments were truncated (see the `truncated`
 * field on the `tool-call` event). The call did not run and has no side effect.
 *
 * The `truncated` addendum is what makes this distinguishable from an ordinary tool failure, so a
 * `toolresult` hook can recognise it and fold in advice the harness has no business knowing — which
 * argument to split, which of *this* tool's parameters offers a cheaper edit. Narrow with
 * {@link isTruncatedToolResult} rather than duck-typing the shape:
 *
 *   services.hooks.register({ on: 'toolresult', handler: ctx => {
 *     if (!isTruncatedToolResult(ctx.result)) return;
 *     return { result: { ...ctx.result, error: `${ctx.result.error} For a large edit, pass start_line/end_line instead.` } };
 *   }});
 */
export interface TruncatedToolResult {
  error:     string;
  truncated: { tool: string; bytes: number; stopReason?: string };
}

export function isTruncatedToolResult(result: unknown): result is TruncatedToolResult {
  if (typeof result !== 'object' || result === null) return false;
  const t = (result as { truncated?: unknown }).truncated;
  return typeof t === 'object' && t !== null
    && typeof (t as { tool?: unknown }).tool  === 'string'
    && typeof (t as { bytes?: unknown }).bytes === 'number';
}

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
