/**
 * The lease that makes one dream-time pass at a time true across processes, not only within one.
 *
 * A pass can start in the server (a person's `dream_time` call) and in a job's own process (the
 * scheduled pass, under `background-jobs-node`) at once, and an in-process mutex sees neither from the
 * other. Two passes over one fact store race: one merges a fact while the other ranks it and retires it,
 * and two saves of one skill keep only the later pass's merges, with both sets of facts marked merged.
 *
 * So the lease is a document in a store, which is to say durable (on the filesystem backend, a file) and
 * in the same partition as the facts it guards, since a partitioned backend gives each principal both.
 * It carries an expiry, renewed while the pass runs, so a process that crashed or was restarted mid-pass
 * holds nothing once it lapses. A pass that finds it held does not wait: it is skipped.
 *
 * `Store` has no create-if-absent, and a backend's compare-and-swap need not be atomic across processes
 * (the filesystem one is a promise chain in each). So taking the lease is write, settle, read back: each
 * write is a whole-document replacement, so every contender reads back the same last writer and only that
 * one proceeds. A contender whose write lands after another's read-back has read the lease first, since a
 * write follows its own read by far less than the settle.
 */

import type { Store } from '@matatbread/matbot-plugin-api';

export interface DreamLease {
  id:         string;
  version:    string;
  holder:     string;
  acquiredAt: string;
  expiresAt:  string;
}

export const LEASE_TTL_MS      = 10 * 60_000;
const        RENEW_EVERY_MS    = 2 * 60_000;
const        DEFAULT_SETTLE_MS = 250;
const        LEASE_ID          = 'pass';

export type Leased =
  | { held: true;  lost: AbortSignal; release(): Promise<void> }
  | { held: false; by: DreamLease };

export async function acquireLease(
  store: Store<DreamLease>,
  holder: string,
  opts: { settleMs?: number; ttlMs?: number; renewEveryMs?: number } = {},
): Promise<Leased> {
  const ttl   = opts.ttlMs ?? LEASE_TTL_MS;
  const fresh = (): DreamLease => {
    const now = Date.now();
    return { id: LEASE_ID, version: crypto.randomUUID(), holder,
             acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString() };
  };

  const current = await store.get(LEASE_ID);
  if (current !== null && Date.parse(current.expiresAt) > Date.now()) return { held: false, by: current };
  await store.set(LEASE_ID, fresh());
  await new Promise(r => setTimeout(r, opts.settleMs ?? DEFAULT_SETTLE_MS));
  const after = await store.get(LEASE_ID);
  if (after === null || after.holder !== holder) return { held: false, by: after ?? fresh() };

  // Renewed on a timer, not per step: one merge can take minutes without a step boundary. If the lease
  // is found in another's hands (this process stalled past the expiry and was overtaken), `lost` fires
  // so the pass stops at its next judgement call rather than writing over the one now running.
  const lost  = new AbortController();
  const renew = async (): Promise<void> => {
    const cur = await store.get(LEASE_ID);
    if (cur === null || cur.holder !== holder) { lost.abort(new Error('the dream-time lease was taken by another pass')); return; }
    await store.cas(LEASE_ID, cur.version, { ...cur, version: crypto.randomUUID(), expiresAt: new Date(Date.now() + ttl).toISOString() });
  };
  const timer = setInterval(() => { void renew().catch(e => console.warn('[dream/lease] renewal failed:', (e as Error).message ?? e)); },
                            opts.renewEveryMs ?? RENEW_EVERY_MS);

  return {
    held: true,
    lost: lost.signal,
    async release() {
      clearInterval(timer);
      const cur = await store.get(LEASE_ID);
      if (cur !== null && cur.holder === holder) await store.delete(LEASE_ID, cur.version);
    },
  };
}
