import type { MessageContent, Session } from './types.js';

/**
 * A session's `updatedAt` invariant: the timestamp of its last message, or its own `createdAt` when it
 * has none. `updatedAt` tracks *conversational activity*, not structural or metadata edits — so a
 * compaction, cut, split, fork, rename, or archive leaves it (and thus the session's place in a
 * recency-sorted list) untouched, since none of them change which message is last. Kept as a
 * materialised field, not a getter: `Session` round-trips as plain JSON through every storage backend
 * and is sorted on `updatedAt` as a stored column, neither of which survives a live accessor.
 *
 * Apply it to the final session object at every write — `{ ...session, updatedAt: lastActivityAt(session) }`
 * — rather than stamping a fresh `now()`.
 */
export function lastActivityAt(session: Session): string {
  const last = session.messages[session.messages.length - 1];
  return last ? last.createdAt : session.createdAt;
}

/**
 * Index of the turn's user message — the message a durable fold attaches to, and the point a retraction
 * pops back to. `-1` when the session has none.
 */
export function lastUserIndex(session: Session): number {
  return session.messages.findLastIndex(m => m.role === 'user');
}

/**
 * Append `blocks` to the turn's user message, returning a new session. This is what "durable" means
 * everywhere it appears: unlike `ephemeral` (tail-folded into the outgoing copy and discarded), the blocks
 * become part of the user turn — persisted, visible to a reader, and carried by every subsequent provider
 * call in the turn and after it.
 *
 * With no user message the blocks are **dropped rather than orphaned**: there is nothing they could belong
 * to, and appending a message of their own would change the role sequence the adapters depend on.
 *
 * Shared because the three callers must agree: the `screen` hook fold, the runner's raced-verdict
 * correction, and the pump's retract-and-rerun rebase. They were three independent copies of one
 * `findLastIndex` + splice, in two different packages.
 */
export function foldOntoUserTurn(session: Session, blocks: readonly MessageContent[]): Session {
  if (blocks.length === 0) return session;
  const idx = lastUserIndex(session);
  if (idx < 0) return session;
  return { ...session, messages: session.messages.map((m, i) =>
    i === idx ? { ...m, content: [...m.content, ...blocks] } : m) };
}
