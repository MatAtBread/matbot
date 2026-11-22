import type { SteeringDecision } from './steering.js';

// ── Session appends ─────────────────────────────────────────────────────────────

/**
 * A message added to a session outside any turn — a background job's report, an answer merged back
 * from elsewhere.
 *
 * Deliberately narrow: plain text, user or assistant. An append arrives unasked into a history that is
 * replayed to a provider on every later turn, so the arms that carry protocol state are excluded by
 * construction — a `tool-use` without its result, or a `thinking` block whose signature it did not
 * earn, would fail every turn after it rather than this one.
 *
 * **A user message is answered.** An assistant message is written into the session and nothing runs; a
 * user message is a **robo-submit** (`ROBO_SUBMIT`, {@link AppendSubmit}): it is submitted to the session
 * as a turn, which the conversation answers as it would a person's. A user message nobody answered had no
 * use: providers fold adjacent user messages, so the model read it as part of whatever the person typed
 * next, and a redo re-ran it instead of theirs. Its blocks are made `origin: 'robo'` whatever the caller
 * says, being machine-authored, and it goes alone — an append holding a user message holds nothing else,
 * since anything written beside a turn that may run in parallel has no order to it.
 */
export type AppendMessage = AppendSaid | AppendSubmit;

interface AppendBase {
  content:   Array<{ type: 'text'; text: string; origin?: 'robo' }>;
  metadata?: Record<string, unknown>;
}

/** Written into the session, and nothing runs. */
export interface AppendSaid extends AppendBase {
  role: 'assistant';
}

/** A robo-submit: run as a turn of the session, which answers it. */
export interface AppendSubmit extends AppendBase {
  role: 'user';
  /** How it meets a turn already running in the session — with none, all three run it at once. `queue`
   *  waits for that turn; `interrupt` stops it, keeping what it finished, and runs next; `parallel`
   *  answers beside it. Queued or interrupting, it is answered on a session holding every append made
   *  before it starts (the runner writes them before the next turn), and parallel on a copy holding
   *  neither the running turn's work nor anything appended while it runs.
   *
   *  Required, and taken from the request's author, because what decides it is whether the request
   *  depends on messages appended before it — which only the author knows. Not the appender, and not a
   *  job, which cannot even tell whether the session is busy. */
  mode:  SteeringDecision;
  /** Who is asking, in words the answering model is shown beside the message
   *  (`background job "disk-check"`). Set by whoever knows — the scheduler that ran the job, never the job.
   *  Absent ⇒ the model is told only that an automated process sent it. */
  from?: string;
}

export interface AppendResult {
  sessionId:  string;
  /** The ids the appended messages will carry — minted at acceptance, so a caller can name them before
   *  the write has landed. Empty for a robo-submit, whose message is minted when its turn starts and is
   *  named by {@link traceId} until then. */
  messageIds: string[];
  /** The write waits for a turn holding the session, so it has not landed yet. Absent ⇒ it has. */
  deferred?:  true;
  /** A robo-submit's turn: the `traceId` its events carry. The caller may follow it on the runner, and
   *  need not — the turn is the session's, and the append settles once it is submitted. */
  traceId?:   string;
}

/**
 * Adds messages to the end of a session. An assistant message is written and nothing runs; a user message
 * is a robo-submit, submitted to the session as a turn (see {@link AppendMessage}).
 *
 * A running turn owns its session: the runner works on an in-memory copy and writes it back whole when
 * the turn ends, which is what keeps the stored session a set of completed turns. So an append is written
 * by the session's runner once no turn holds that session (`SessionRunner.write`), and announced then as a
 * `SessionAppend` notification. When no turn holds it, that is at once, and the append settles once
 * written, reporting a write that could not land. When one does, it settles once **accepted**: the caller
 * may be that very turn, and awaiting the write from inside it would deadlock.
 *
 * The host seeds one in every process that holds the session store. A background job does not get
 * one: it shares the store's medium with its parent but none of the parent's pumps, so a write it made
 * would race them unseen. A job registers one that forwards to its parent instead; with neither, a
 * caller refuses rather than writing.
 */
export interface SessionAppender {
  /** Where an append naming no session goes, when this process has a destination of its own — a
   *  background job's: the conversation it reports to. Absent ⇒ the caller supplies its own session. */
  readonly defaultSessionId?: string;
  append(sessionId: string | undefined, messages: readonly AppendMessage[]): Promise<AppendResult>;
}
