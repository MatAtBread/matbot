import type { FileHandle } from './files.js';
import type { MessageContent, Session } from './messages.js';
import type { Usage } from './provider.js';

// ── Pipeline events ─────────────────────────────────────────────────────────────

/**
 * A turn's own events. `traceId` — the turn that produced it — is the correlation key a frontend routes
 * on (see `SessionRunner`), and every arm here carries it. Grouped by what a consumer does with them:
 * streamed model output, tool progress, live delivery of something already persisted, and the terminals.
 *
 * A turn ends with **exactly one** terminal: `done`, `aborted` (interrupted mid-flight), or `error`.
 */
export type TurnEvent =
  // ── streamed model output ──
  | { type: 'text-delta';     delta: string;          traceId: string }
  | { type: 'thinking';       delta: string;          traceId: string }
  | { type: 'system-context'; text: string;           traceId: string }
  | ({ type: 'usage';         traceId: string } & Usage)

  // ── tool execution ──
  | { type: 'tool:start';     callId: string; name: string; input: unknown; traceId: string }
  | { type: 'tool:stdout';    callId: string; chunk: string;  traceId: string }
  | { type: 'tool:stderr';    callId: string; chunk: string;  traceId: string }
  | { type: 'tool:progress';  callId: string; pct: number; message?: string; traceId: string }
  // `durationMs` is the runner's own bracket around the executor — the same number persisted as the
  // call's `span` entry, carried live so a frontend can draw it without waiting for the idle flush.
  // Absent for a call that never ran (a rejected or severed one), which is not the same as 0ms.
  | { type: 'tool:end';       callId: string; result: unknown; isError: boolean; durationMs?: number; traceId: string }

  // ── live delivery of state that is ALREADY persisted; never the source of truth ──
  | { type: 'file';           handle: FileHandle;     traceId: string }
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

  // ── queue disposition ──
  // A queued (not-yet-running) submission, carried on the stream so a frontend renders it as part
  // of the live "delta" (everything after the last committed message), never from stored state.
  // `queued` is the number of submissions ahead of it (0 ⇒ about to run). Emitted live on enqueue
  // and replayed (in queue order) to anyone subscribing mid-flight.
  | { type: 'queued';         content: MessageContent[]; queued: number; concatQueue: boolean; traceId: string; rootTraceId: string }
  // A mid-turn steer that INTERRUPTED the running turn (see `SteeringPolicy`). Emitted synchronously
  // when the steer is accepted, so the new user bubble lands in correct stream order and a frontend
  // knows the imminent `aborted` (reason 'steer') on `interruptedTraceId` is a yield, not a dead-end:
  // keep that turn's partial work rendered and expect a continuation. `traceId`/`rootTraceId` identify
  // the steer submission itself (the continuation turn). Late subscribers reconstruct the bubble from
  // the pump's per-turn `queued` replay seed / committed store order — this is purely live delivery.
  | { type: 'steer';          content: MessageContent[]; interruptedTraceId: string; traceId: string; rootTraceId: string }

  // ── terminals: exactly one per turn ──
  | { type: 'done';           session: Session;       traceId: string }
  | { type: 'aborted';        reason: string; session: Session; traceId: string }
  | { type: 'error';          error: string;          traceId: string }
  // A queued submission dropped before it ever ran (e.g. by `SessionRunner.abort`). It carries no
  // session because nothing ran and so nothing was persisted — but it does have a traceId: the
  // submission it cancels was assigned one at enqueue, and a frontend needs it to retire that bubble.
  | { type: 'cancelled';      sessionId: string;      traceId: string };

/**
 * Events about the *session*, not any one turn — hence keyed on `sessionId` with no `traceId`. Split from
 * {@link TurnEvent} so that absence is type-checkable rather than a comment: `idle` was the single arm of
 * a 20-arm union without a `traceId`, which every consumer had to know by having read the note saying so.
 */
export type SessionEvent =
  // The runner has fully drained its queue. Emitted once per busy period, *after* `running` flips false,
  // so a consumer can map it to an authoritative busy→idle transition without racing the internal flip.
  | { type: 'idle';           sessionId: string };

/**
 * The streaming output of a session: its turns' events, plus the session-level ones.
 *
 * Consumers that only ever see one turn (a tool reporting progress, a per-turn frontend) should narrow to
 * {@link TurnEvent} and get `traceId` unconditionally; a subscriber to a whole session takes this union
 * and must handle `idle`. Switching on `type` works the same either way.
 */
export type PipelineEvent = TurnEvent | SessionEvent;
