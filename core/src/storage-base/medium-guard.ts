import type { Store, CASResult, StoreQuery, QueryResult } from '@matatbread/matbot-plugin-api';

/**
 * Fail a write whose read came from a different storage medium.
 *
 * Exactly one `StorageBackend` is active, nothing is migrated between them, and a swap repoints every
 * store proxy at once. A caller that read a document before the swap and writes it after is therefore
 * addressing two different media with one read-modify-write, and neither end can tell: `cas` asks
 * "did this document change?", which the new backend answers about a document it never issued — most
 * often "there is nothing here", at which point an unconditional `set` writes the old backend's
 * document into the new one and the session has silently migrated. Compare-and-swap cannot see this,
 * because the medium is not what it compares.
 *
 * The fix belongs here rather than at whatever happened to be running: the exposure is not particular
 * to the quiescent edge's deferred work — an HTTP tool call has always been able to straddle a swap
 * the same way — so pushing the check up to every caller would be asking each of them to know
 * something only storage knows.
 *
 * The version is the only token tying a read to its write, so it carries the medium: stamped on the
 * way out, checked and stripped on the way in. Stripping is what keeps it invisible — a caller that
 * writes a document straight back (`store.set(id, { ...doc, title })`, which does not bump the
 * version) must not persist a stamp, or the next read would stamp it twice.
 *
 * An UNstamped version is always accepted: that is a document the caller minted rather than read, and
 * a create has no earlier medium to disagree with.
 */

const STAMP = /^m(\d+)~([\s\S]*)$/;

interface Stamped { id: string; version: string }

function stamp<T extends Stamped>(doc: T, generation: number): T {
  return { ...doc, version: `m${generation}~${doc.version}` };
}

type Checked =
  | { ok: true; version: string }
  | { ok: false; from: number };

function check(version: string, generation: number): Checked {
  const m = STAMP.exec(version);
  if (m === null)                      return { ok: true, version };            // minted, not read
  if (Number(m[1]) === generation)     return { ok: true, version: m[2]! };
  return { ok: false, from: Number(m[1]) };
}

/** Strip a stamp wherever one appears, so nothing a caller hands back is persisted with one. */
function strip<T extends Stamped>(doc: T): T {
  const m = STAMP.exec(doc.version);
  return m === null ? doc : { ...doc, version: m[2]! };
}

/**
 * Wrap `inner` so every document it hands out is stamped with the medium generation it came from, and
 * every write is checked against the generation current at the time of the write. `generation` must
 * increase on every backend swap; the wrapper is placed OUTSIDE the swap proxy, so it is one stable
 * object across every swap and a captured store reference keeps working.
 */
export function mediumGuard<T extends { id: string; version: string }>(
  inner:      Store<T>,
  generation: () => number,
  namespace:  string,
): Store<T> {
  const stale = (op: string, id: string, from: number): string =>
    `${op} on "${namespace}/${id}" read from storage backend generation ${from}, but generation ${generation()} is now active. ` +
    'Nothing is migrated between backends, so this write would put a document from the previous one into its replacement. Re-read and retry.';

  return {
    async get(id) {
      const doc = await inner.get(id);
      return doc === null ? null : stamp(doc, generation());
    },

    async query(q: StoreQuery): Promise<QueryResult<T>> {
      const page = await inner.query(q);
      const gen  = generation();
      return { ...page, items: page.items.map(d => stamp(d, gen)) };
    },

    async set(id, value) {
      const seen = check(value.version, generation());
      // `set` has no failure channel, and silence is what makes the migration invisible — so it
      // throws. It is reachable only after a swap, holding a document read before it.
      if (!seen.ok) throw new Error(stale('set', id, seen.from));
      await inner.set(id, strip(value));
    },

    async cas(id, expected, next): Promise<CASResult<T>> {
      const seen = check(expected, generation());
      // Reported as a lost CAS rather than thrown: the caller already has a path for "someone else got
      // there first", and this is that, with the medium in the role of the other writer. `current` is
      // read from the backend now in force — the document the caller must reconcile against.
      if (!seen.ok) {
        console.warn(`[matbot] ${stale('cas', id, seen.from)}`);
        const current = await inner.get(id);
        return { ok: false, current: current === null ? null : stamp(current, generation()) };
      }
      const res = await inner.cas(id, seen.version, strip(next));
      const gen = generation();
      if (res.ok) return { ok: true, doc: stamp(res.doc, gen) };
      return { ok: false, current: res.current === null ? null : stamp(res.current, gen) };
    },

    async delete(id, expectedVersion) {
      if (expectedVersion === undefined) return inner.delete(id);
      const seen = check(expectedVersion, generation());
      if (!seen.ok) {
        console.warn(`[matbot] ${stale('delete', id, seen.from)}`);
        return false;
      }
      return inner.delete(id, seen.version);
    },
  };
}
