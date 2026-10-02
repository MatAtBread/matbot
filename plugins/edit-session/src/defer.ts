import { casAtEdge } from '@matatbread/matbot-core';

/**
 * Run an edit of a session a turn is running in once that turn has committed: `casAtEdge`, which writes at
 * the quiescent edge as the caller and reads again when the write loses its compare-and-swap.
 *
 * What this adds is serialisation of this plugin's own edits against each other. Flushers settle together,
 * so two deferred edits of one session would race for the same document. Each would recover by reading
 * again, but every loss spends one of a bounded number of attempts, and a turn that queues a compact, a
 * cut and a summarise should not have them compete. A throw is logged here and ends that edit, since
 * nobody is left to report it to.
 */
let tail: Promise<unknown> = Promise.resolve();

export function defer(attempt: () => Promise<boolean>, lost: string): void {
  casAtEdge(() => {
    const run = tail.then(attempt).catch((e: unknown) => {
      console.error('[edit-session] deferred edit failed:', e instanceof Error ? e.message : e);
      return true;
    });
    tail = run;
    return run;
  }, lost);
}
