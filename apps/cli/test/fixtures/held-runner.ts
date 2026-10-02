import type { SessionRunner, SessionWrite } from '@matatbread/matbot-plugin-api';

/**
 * The runner's write contract (`SessionRunner.write`) with the turn under the test's control: a write of
 * the `busy` session waits for `endTurn` — which first applies whatever the test says that turn committed —
 * and any other is made at once, after `write` returns. Each gets three attempts, as the runner's do. For
 * testing what a plugin hands the runner; the runner's own half is session-runner-write.test.ts.
 */
export function heldRunner(busy: string): { run: SessionRunner; endTurn: (commit?: () => void) => Promise<void> } {
  const queued: Array<() => Promise<void>> = [];
  const tries = async (attempt: () => Promise<boolean>, lost: string): Promise<void> => {
    for (let n = 0; n < 3; n++) if (await attempt()) return;
    console.error(lost);
  };
  const run = {
    status: (id: string) => ({ busy: id === busy, running: id === busy, queued: 0, parallel: 0 }),
    write: (id: string, attempt: () => Promise<boolean>, lost: string): SessionWrite => {
      if (id !== busy) return { deferred: false, done: Promise.resolve().then(() => tries(attempt, lost)) };
      let settle!: () => void;
      const done = new Promise<void>(r => { settle = r; });
      queued.push(async () => { await tries(attempt, lost); settle(); });
      return { deferred: true, done };
    },
  } as unknown as SessionRunner;
  return {
    run,
    async endTurn(commit) {
      commit?.();
      for (const q of queued.splice(0)) await q();
    },
  };
}
