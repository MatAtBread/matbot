import type { PipelineEvent } from './events.js';
import type { MessageContent, Session } from './messages.js';
import type { MimeType } from './primitives.js';
import type { Principal } from './principal.js';
import type { SteeringMode } from './steering.js';
import type { PromptFn } from './tools.js';
import type { Store } from './storage.js';

// ── Session runner ──────────────────────────────────────────────────────────────

/**
 * A view onto a session returned by `SessionRunner.open`. `session` is the authoritative
 * server-side state — committed messages only, ending at the running turn's user message. The
 * in-flight turn and any queued submissions are the delta, delivered over `events`, never overlaid
 * here. `events` is a lazy, per-session live tap: accessing it subscribes to the turn event stream
 * from now (replaying the in-flight turn, then the queue); never touching it costs nothing.
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
   *  committed partial work — and runs this next, 'parallel' answers it now beside the running turn
   *  (see the `parallel` event), 'auto' defers to the registered SteeringPolicy (else the host
   *  default). Meaningless when nothing is running (degrades to a plain enqueue). */
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
  /** Abort the running turn (if any), any `parallel` turns beside it, and drop all queued submissions,
   *  emitting `cancelled` for each. */
  abort(sessionId: string): void;
  /** Stop ONE `parallel` turn, leaving the running turn, the queue and any other parallel turns alone.
   *  A parallel turn is the only kind that can be stopped individually: it runs on a nested runner with
   *  a stop of its own, where a queued submission has not started and the running turn is what `abort`
   *  and `cancelTurn` already address. It still settles and writes back its pair, carrying a note in
   *  place of the reply — the submission was made, and dropping it would lose that. A no-op if no
   *  parallel turn of the session carries this traceId. Deliberately its own method rather than an
   *  optional argument to `abort`: an implementation that ignored the argument would silently stop
   *  everything, which is the opposite of what the caller asked. */
  abortParallel(sessionId: string, traceId: string): void;
  /** Abandon the running turn (if any) WITHOUT touching the queue — `pump` advances to the next
   *  queued submission, or idles. The "give up on this turn" path (a prompt cancel); contrast
   *  `abort`, which also clears the queue. A no-op if nothing is running. */
  cancelTurn(sessionId: string): void;
  /** Snapshot of a session's live state: whether a turn is running, how many submissions wait behind
   *  it, and how many `parallel` turns are in flight beside it. `busy` is any of the three. */
  status(sessionId: string): { busy: boolean; running: boolean; queued: number; parallel: number };
  /**
   * Write session `sessionId` from outside its turns — an append, a rename, an edit of its history.
   *
   * A turn works on an in-memory copy of its session and writes it back whole when it ends, so a write
   * landing during a turn is undone by that write-back. The runner is therefore the session's one writer:
   * it runs `attempt` between that session's turns, in the order writes arrive, and no turn of the session
   * starts until it has finished. Other sessions' turns do not delay it.
   *
   * `attempt` reads the session itself and writes it with compare-and-swap, which still answers any writer
   * outside this runner (another process sharing the store). It resolves `false` only when that CAS lost,
   * to be read and tried again, and `true` once finished, whether or not it wrote; it reports its own
   * failures. `lost` is logged if every attempt loses. It runs as the principal in force at this call.
   *
   * It never runs before this call returns. See {@link SessionWrite} for when awaiting it is safe.
   */
  write(sessionId: string, attempt: () => Promise<boolean>, lost: string): SessionWrite;
}

/** A write handed to {@link SessionRunner.write}. */
export interface SessionWrite {
  /** A turn of the session was in progress, so the write waits for it to end. Then never await `done`
   *  from that turn: its end is what the write is waiting for. */
  deferred: boolean;
  /** Settles once the write has run, however it ended (each failure is logged). Never rejects. */
  done:     Promise<void>;
}

/** A runner and the store it alone reads and writes — see {@link MatbotRuntime.ephemeral}. */
export interface EphemeralRun {
  sessions: Store<Session>;
  run:      SessionRunner;
}
