import type { PipelineEvent } from './events.js';
import type { MessageContent, Session } from './messages.js';
import type { MimeType } from './primitives.js';
import type { Principal } from './principal.js';
import type { SteeringMode } from './steering.js';
import type { PromptFn } from './tools.js';

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

/**
 * What a *person* may submit — deliberately a narrow subset of {@link MessageContent}, not all of it.
 * A submission crosses a wire boundary (an HTTP body, a chat platform's update), and widening it to
 * the full union would let a client post a forged `tool-result`, `thinking` block or `marker` straight
 * into persisted history.
 *
 * The three inline media arms are a **boundary form only**: `open()` writes them through the
 * `MediaStore` and replaces each with a `file-ref` before the submission is enqueued, so what persists
 * is always a reference. Bytes are never written into a session document — a 5MB image is ~6.7MB of
 * base64 riding *both* whole-document writes of every subsequent turn, for the rest of the session.
 * A caller that has already uploaded (or, like the web composer, would rather not re-post bytes) may
 * pass the `file-ref` itself and skip the rewrite.
 */
export type UserContent = (
  | { type: 'text';          text: string }
  | { type: 'image';         data: string; mimeType: MimeType; name?: string }
  | { type: 'document';      data: string; mimeType: MimeType; name?: string }
  | { type: 'audio';         data: string; mimeType: MimeType; name?: string }
  | { type: 'file-ref';      fileId: string; name: string; mimeType: MimeType }
  | { type: 'form-response'; values: Record<string, string> }
) & {
  /** Authorship, carried through exactly as on {@link MessageContent} — an in-process caller driving a
   *  session (the skills compiler's scratch run) submits machine-authored content and must be able to
   *  say so. Unlike the arms above this is presentation, not protocol: a remote client asserting it only
   *  makes its own bubble render agent-side, so it costs the boundary nothing to accept. */
  origin?: 'robo';
};

/** Observe a session AND enqueue a submission. The compiler enforces provider/principal here;
 *  a remote frontend deserializing a request body must still validate the wire input itself. */
export interface SubmitOpenOpts extends OpenOpts {
  /** Text plus, optionally, media. Inline media arms are rewritten to `file-ref`s against the
   *  `MediaStore` before enqueue; with no store registered the submission is refused (see
   *  {@link MediaRejectedError}) rather than silently dropping what the user attached. */
  content:      UserContent[];
  provider:     string;
  principal:    Principal;
  /** When true, this submission may be merged with others drained in the same batch. Default false
   *  (queue mode: one turn per submission). */
  concatQueue?: boolean;
  /** Disposition for a submission arriving while a turn is running (see {@link SteeringPolicy}):
   *  'queue' waits for the turn boundary (default), 'interrupt' stops the running turn — keeping its
   *  committed partial work — and runs this next, 'auto' defers to the registered SteeringPolicy (else
   *  the host default). Meaningless when nothing is running (degrades to a plain enqueue). */
  mode?:        SteeringMode;
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
