import type { Message, MessageContent, Session } from './messages.js';
import type { PromptFn, Tool } from './tools.js';

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
/**
 * A raced screen verdict the runner folds in WITHOUT gating the turn on it. A `screen` hook that starts
 * expensive work concurrently (e.g. a triggers classifier judging the user message) returns immediately
 * and hands back one of these instead of blocking on it. The runner polls `claim()` — synchronously,
 * never awaiting — at each turn-loop edge (before a provider call, on every stream event, and just
 * before committing). The first time `claim()` returns blocks (the work has settled WITH a correction),
 * the runner DISCARDS the uncommitted in-progress response and re-runs the loop with those blocks
 * tail-folded as ephemeral context — an in-situ redo: no store pop, no retraction marker, cleaner than a
 * post-commit retract. Because the mid-stream poll runs before each event is emitted, a verdict faster
 * than time-to-first-token is caught before any token reaches the frontend (the clean path); a slower
 * one aborts the in-flight provider request, saving the unstreamed remainder. If it never fires before
 * the turn commits, the turn commits normally and any correction is left to a post-commit `followup`.
 *
 * `claim()` MUST be exactly-once: return the correction on the first successful poll and `undefined`
 * forever after (not settled, no correction, or already claimed). The hook uses that single delivery to
 * coordinate with its own post-commit path — a claimed verdict is never also delivered by `followup`.
 */
export interface DeferredScreen {
  claim(): DeferredCorrection | undefined;
}
/**
 * A claimed raced-verdict correction. `ephemeral` is tail-folded onto the re-run's outgoing messages
 * and never persisted (the transient "for this answer only" twin); `durable` is folded onto the turn's
 * user message — persisted, visible (the hook marks it `origin: 'robo'`), and carried live as a
 * `robo-user` event — so it updates the conversation rather than informing one answer (a `contextual`
 * trigger's semantics, preserved even though the verdict now lands mid-turn instead of before it). At
 * least one is non-empty when returned.
 */
export interface DeferredCorrection {
  ephemeral?: MessageContent[];
  durable?:   MessageContent[];
}
export interface ScreenResult {
  session?:   Session;
  /**
   * A raced verdict the runner folds in without gating on it (see {@link DeferredScreen}). Lets a
   * screen hook race expensive work — a classifier — against generation: return immediately, hand this
   * back, and the runner restarts the turn in-situ if the verdict fires before commit. A hook that
   * would rather gate the turn (block until the verdict) just returns `ephemeral` as usual instead.
   */
  deferred?:  DeferredScreen;
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
   *
   * `context` is folded EPHEMERALLY onto the redo (for-this-answer-only). `durable` is instead folded
   * onto the re-run's user message — persisted, visible (mark it `origin: 'robo'`), carried live as a
   * `robo-user` event — so a `contextual`-kind correction updates the conversation durably even when it
   * lands post-commit. At least one of the two is present.
   */
  retractAndRerun?: { context?: MessageContent[]; durable?: MessageContent[] };
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
