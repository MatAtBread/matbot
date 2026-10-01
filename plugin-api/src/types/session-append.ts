// ── Session appends ─────────────────────────────────────────────────────────────

/**
 * A message added to a session outside any turn — a background job's report, an answer merged back
 * from elsewhere.
 *
 * Deliberately narrow: plain text, user or assistant. An append arrives unasked into a history that is
 * replayed to a provider on every later turn, so the arms that carry protocol state are excluded by
 * construction — a `tool-use` without its result, or a `thinking` block whose signature it did not
 * earn, would fail every turn after it rather than this one.
 */
export interface AppendMessage {
  role:      'user' | 'assistant';
  content:   Array<{ type: 'text'; text: string; origin?: 'robo' }>;
  metadata?: Record<string, unknown>;
}

export interface AppendResult {
  sessionId:  string;
  /** The ids the appended messages will carry — minted at acceptance, so a caller can name them before
   *  the write has landed. */
  messageIds: string[];
}

/**
 * Adds messages to the end of a session without running a turn.
 *
 * A running turn owns its session: the runner works on an in-memory copy and writes it back whole when
 * the turn ends, which is what keeps the stored session a set of completed turns. So an append is
 * applied at the quiescent edge, where no turn holds any session, and announced then as a
 * `SessionAppend` notification. It settles once **accepted**, not once written — the edge cannot
 * arrive while the caller's own turn is running, so awaiting the write from a tool would deadlock.
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
