import type { FileHandle } from './files.js';
import type { MessageContent, Session } from './messages.js';
import type { Usage } from './provider.js';

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
  // A mid-turn steer that INTERRUPTED the running turn (see `SteeringPolicy`). Emitted synchronously
  // when the steer is accepted, so the new user bubble lands in correct stream order and a frontend
  // knows the imminent `aborted` (reason 'steer') on `interruptedTraceId` is a yield, not a dead-end:
  // keep that turn's partial work rendered and expect a continuation. `traceId`/`rootTraceId` identify
  // the steer submission itself (the continuation turn). Late subscribers reconstruct the bubble from
  // the pump's per-turn `queued` replay seed / committed store order — this is purely live delivery.
  | { type: 'steer';          content: MessageContent[]; interruptedTraceId: string; traceId: string; rootTraceId: string }
  | { type: 'error';          error: string;          traceId: string }
  | { type: 'system-context'; text: string;           traceId: string };
