import type { Session } from './types.js';

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
