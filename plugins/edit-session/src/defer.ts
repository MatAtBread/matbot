import { onContextQuiesce } from '@matatbread/matbot-plugin-api/host';

/**
 * Run an edit of the *running turn's own* session after that turn has committed.
 *
 * The runner holds one in-memory copy of the session document and writes it back unconditionally at
 * turn end, so an edit landing mid-turn is silently overwritten. The quiescent edge is the first
 * moment the committed document is readable — and it is by construction unreachable until the tool
 * call, and the turn, have returned. Hence "defer, and say so": the caller cannot be told the
 * outcome, because waiting for it would hold open the very edge it is waiting for.
 */

// Serialises deferred edits against each other: two landing at once would CAS the same document
// concurrently, and applying an index-based edit to already-shifted history is nonsense.
let tail: Promise<void> = Promise.resolve();

// A one-shot quiescer, unregistering itself as it fires: the flusher contract asks for idempotence,
// and running exactly once is how this one gets it. The work is detached because a quiescer is
// synchronous and nothing awaits its result.
export function defer(job: () => Promise<void>): void {
  const un = onContextQuiesce(() => {
    un();
    tail = tail.then(job).catch(e => console.error('[edit-session] deferred edit failed:', e instanceof Error ? e.message : e));
  });
}
