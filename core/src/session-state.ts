import type { Message, MessageContent, Principal, PromptFn, PipelineEvent, TurnEntry } from './types.js';

// What the session runner keeps per session, and the channel a subscriber reads it through. Plain data and
// the two ways an event reaches subscribers; the runner (session-runner.ts) and the parallel-reply
// placement (session-merges.ts) both act on it.

export interface QueuedItem {
  traceId:     string;
  // The originating human turn's traceId, carried down a resubmission chain (a human submit is its
  // own root). Lets a per-turn frontend (e.g. telegram) adopt the followups *its* turn spawned and
  // ignore unrelated turns — lineage the bare per-turn traceId can't express.
  rootTraceId: string;
  content:     MessageContent[];
  provider:    string;
  principal:   Principal;
  concatQueue: boolean;
  // 0 for an external submission; a `react` resubmission carries its parent's depth + 1. The reactor
  // budgets against it, and pump hard-caps it (MAX_RESUBMIT_DEPTH) so a misbehaving reactor can't loop.
  resubmitDepth: number;
  // Present ⇒ this item RE-RUNS an already-committed user turn (an agent-phase retract-redo) rather
  // than introducing a new user message: the pump skips the persist-at-turn-start append (the user
  // message already exists) and hands `ephemeral` (the trigger tool's output) to runSession, which
  // tail-folds it for this run only. `content` is empty for such an item — there is no new bubble.
  // `head` is the user message the retraction kept (see `SessionState.turnHead`), absent if there was none.
  redo?: { ephemeral: MessageContent[]; head?: { id: string; request: string } };
  // Turn-scoped ephemeral context to fold onto this item's turn (tail-folded, never persisted) — used
  // to carry an interrupt's "keep going, noting the above" nudge. Feeds runSession's injectedEphemeral,
  // the same path `redo` uses; the two are mutually exclusive in practice (redo re-runs an existing
  // turn with no new message, a steer introduces a new user message).
  injectEphemeral?: MessageContent[];
  prompt?:     PromptFn;
}

// A parallel turn's write-back: its submission and everything the turn produced, ready to place. Built
// once, when the parallel turn settles; placed by whoever holds the session at that moment (see
// `merges`).
export interface ParallelReply {
  traceId:  string;
  /** The turn's head first, then its whole span — thinking, tool calls, their results, its markers and
   *  its final reply. Non-empty by construction, which is what keeps `messages[0]` the head: every
   *  placement path dedupes on that id. */
  messages: [Message, ...Message[]];
  /** The id of the message this reply's copy was cut AT — the running turn's head when it was submitted,
   *  captured then. The pair belongs immediately ahead of it, because that is where the history the reply
   *  was generated against ended. Absent ⇒ the copy was cut at the end of the session (nothing was
   *  running, or the turn's rounds were already over and only its `followup` hooks were left), so the
   *  pair belongs at the TAIL and there is no id to place it against. */
  head?:    string;
  /** Written to the store by `placeNow` when it settled, rather than left for the running turn's next
   *  round boundary. It stays on `merges` all the same, because the running turn's in-memory session
   *  must still learn of it or that turn's whole-document write-back erases it — but it must never be
   *  written or announced a second time, which is what every reader of this flag is for. */
  persisted?: boolean;
}

export interface SessionState {
  // The queue is deliberately a plain array, drained FIFO. concatQueue is per-submission: a non-concat
  // submission is its own turn — faithful, and correct when one submission's tools/state are a
  // precondition for the next (e.g. "add plugin X" then "use X": tools are rebuilt per turn, so X is
  // only visible to a *later* turn). A run of consecutive concat submissions merges into one turn —
  // cheaper, and the common "let me add more context now" case — without collapsing the queued/robo
  // submissions interleaved among them (see the batch-building loop in pump). Concat and queued mix freely.
  queue:       QueuedItem[];
  running:     boolean;
  // traceId of the turn currently running (set at pump loop top, cleared when the turn ends). Lets an
  // interrupt name the turn it is yielding, so a frontend correlates the `steer` event's
  // `interruptedTraceId` with the `aborted` (reason 'steer') it is about to see.
  runningTraceId: string | undefined;
  ac:          AbortController | undefined;
  subscribers: Set<Sink>;
  // Events of the *current* turn, replayed to a subscriber that joins mid-turn. Cleared at each
  // turn boundary — committed history comes from the store, not from here.
  replay:      PipelineEvent[];
  // Accounting entries awaiting a flush, held BY REFERENCE to each turn's usage scope. A completion
  // can be recorded after its turn commits — a detached trigger classifier, a `followup` hook — and it
  // appends to the very array captured here, so a late arrival needs no coordination: whatever is in
  // these arrays at the flush is what gets written, and each entry says which turn caused it.
  pendingUsage: TurnEntry[][];
  // ── parallel turns (`mode: 'parallel'`) ──
  // Each in flight, by traceId: its own replay (it outlives the running turn's, which is cleared at every
  // boundary) and how to stop it.
  parallel:    Map<string, { replay: PipelineEvent[]; stop: AbortController }>;
  // Settled replies awaiting placement. Drained by whichever holder reaches a safe point first: the
  // running turn at its next round boundary (`interject`), else the pump between turns. Never the
  // SessionAppender — that writes at the quiescent edge, which cannot arrive until the pump's whole
  // queue drains, and the point of a parallel turn is not waiting for that.
  merges:      ParallelReply[];
  // The running turn's first own message (its user message; for a redo, the kept one): its id is where
  // the copy a parallel turn runs on ends, and so where its pair is placed while this turn runs; its text
  // is the request that copy's framing names. Set together with `runningTraceId`, in the step that takes
  // the item off the queue: `runningTraceId` is what admits a parallel turn, so set any later — even after
  // the store read that follows — one arriving in between had no head, ran unframed, and copied the turn
  // it was beside. Cleared once the turn's rounds end, because from then
  // on the turn has answered, and a parallel turn should see the answer rather than be told it is
  // still being worked on.
  turnHead:    { id: string; request: string } | undefined;
  // Replies placed into the running turn's in-memory copy and not yet committed: a parallel turn started
  // now must see them, and they reach the store only when that turn ends.
  interjected: ParallelReply[];
  // Set while the pump has run out of queue but still holds the machine for a parallel turn: resolving it
  // resumes the loop.
  wake:        (() => void) | undefined;
  // Writes from outside the turns (`SessionRunner.write`), waiting for a moment no turn holds the session.
  writes:      Array<() => Promise<void>>;
}

export interface Sink {
  push(ev: PipelineEvent): void;
  close(): void;
  iterable: AsyncIterable<PipelineEvent>;
}

// A single-consumer push channel surfaced as an AsyncIterable. `dispose` runs when the consumer
// stops (break/return) or the channel closes, so an abandoned subscriber unregisters itself.
export function createSink(dispose: () => void): Sink {
  const buffer: PipelineEvent[] = [];
  let waiting: ((r: IteratorResult<PipelineEvent>) => void) | null = null;
  let closed = false;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (waiting) { const w = waiting; waiting = null; w({ value: undefined as never, done: true }); }
  };

  return {
    push(ev) {
      if (closed) return;
      if (waiting) { const w = waiting; waiting = null; w({ value: ev, done: false }); }
      else buffer.push(ev);
    },
    close: finish,
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<PipelineEvent> {
        return {
          next() {
            const head = buffer.shift();
            if (head !== undefined) return Promise.resolve({ value: head, done: false });
            if (closed)            return Promise.resolve({ value: undefined as never, done: true });
            return new Promise(res => { waiting = res; });
          },
          return() {
            finish();
            dispose();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    },
  };
}

// Turn events go to the replay buffer (so a mid-flight subscriber sees the in-progress turn) and
// all live subscribers.
export function emit(s: SessionState, ev: PipelineEvent): void {
  s.replay.push(ev);
  for (const sink of s.subscribers) sink.push(ev);
}

// Subscribers-only (no replay buffer): used for the `queued` events that describe the pending
// queue. Pending is NOT kept in `replay` (which is per-turn) — it's reconstructed from `s.queue`
// when a subscriber joins, so it survives turn boundaries correctly.
export function notify(s: SessionState, ev: PipelineEvent): void {
  for (const sink of s.subscribers) sink.push(ev);
}

// How many submissions sit ahead of the item at queue index `i` (the running turn counts as one).
export const aheadOf = (s: SessionState, i: number): number => (s.running ? 1 : 0) + i;
