import { onContextQuiesce, runAs, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

// A conflict at the edge means another writer landed between an attempt's read and its write, and at the
// edge that is another flusher, never a turn. Re-reading composes with it; the bound only stops a
// pathological loop.
const EDGE_ATTEMPTS = 3;

/**
 * Write once at the next quiescent edge, as the principal in force now, and read again if the write loses
 * its compare-and-swap.
 *
 * For a write to a session a turn is running in: the turn holds a copy of the document and writes it back
 * whole when it ends, so a write landing earlier is undone. The edge is the first moment no turn holds a
 * copy, and nothing can reach it from inside the turn, so the caller cannot be told the outcome; it is
 * logged instead.
 *
 * `attempt` reads the document itself, never a copy taken before the edge, which is exactly the state a
 * turn is about to overwrite. It resolves to `false` only when its compare-and-swap lost and it should
 * read and try again. `true` means it is finished, whether it wrote or found nothing it could do; it logs
 * its own failures, which only it can describe. `lost` is logged once the attempts run out.
 *
 * The principal is restored because the edge runs outside every scope and the store is
 * ownership-checked. The work is returned to the edge, not detached, so the edge holds back the next
 * turn's read of the document until the write has landed.
 */
export function casAtEdge(attempt: () => Promise<boolean>, lost: string): void {
  const principal = tryCurrentPrincipal();
  const write = async (): Promise<void> => {
    for (let n = 0; n < EDGE_ATTEMPTS; n++) if (await attempt()) return;
    console.error(lost);
  };
  onContextQuiesce(un => {
    un();
    return principal !== undefined ? runAs(principal, write) : write();
  });
}
