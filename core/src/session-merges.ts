import type { Message, Session, Store, TurnEntry, UserContent } from './types.js';
import type { ParallelReply, SessionState } from './session-state.js';
import { notify } from './session-state.js';
import { appendMessage } from './session.js';
import { isReadOnlyError } from '@matatbread/matbot-plugin-api';

// Writing into a session from beside its turns: a settled parallel turn's reply placed into history, the
// writes queued for a moment no turn holds the session, and the accounting a turn leaves behind. Each is
// a function of the store and the runner's per-session state, so none of it needs the runner's closure.

// Tries a write gets (see `SessionRunner.write`). Writes of one session are applied one at a time, so a lost
// compare-and-swap means a writer outside this runner — another process on the same store, a storage swap
// `mediumGuard` refused — and reading again composes with it. The bound only stops a pathological loop.
export const WRITE_ATTEMPTS = 3;

// Folded onto a parallel turn's message in ITS copy only (never written back): without it, a model asked
// "how's it going?" mid-task sees a history that ends a turn early and answers as though nothing were
// running. Names the running request so the reply can be about it, and says what happens to the reply.
const PARALLEL_FRAMING_CAP = 2_000;
export const parallelFraming = (running: string): Extract<UserContent, { type: 'text' }> => ({
  type: 'text',
  origin: 'robo',
  text: 'A separate turn of this conversation is still working on the request below, and you cannot see its '
    + 'progress or results. Answer the message above on its own terms; your final reply is added to the '
    + 'conversation that turn sees.\n\n<running-request>\n'
    + (running.length > PARALLEL_FRAMING_CAP ? `${running.slice(0, PARALLEL_FRAMING_CAP)}…` : running)
    + '\n</running-request>',
});

// A parallel turn's span as it can be placed into shared history: trimmed back to the last point at
// which every tool-call in it has its result. An abort (or a failure mid-round) leaves a trailing
// tool-call with nothing answering it, and an unpaired call is not valid wire for any provider — it
// would break not just this placement but every later turn of the session.
export const closedSpan = (msgs: Message[]): Message[] => {
  const open = new Set<string>();
  let closed = 0;
  for (const [i, m] of msgs.entries()) {
    for (const c of m.content) {
      if (c.type === 'tool-call')        open.add(c.id);
      else if (c.type === 'tool-result') open.delete(c.id);
    }
    if (open.size === 0) closed = i + 1;
  }
  return msgs.slice(0, closed);
};

/**
 * Write whatever accounting has accrued onto the turn heads that caused it, then clear it.
 *
 * Entries are drained by SPLICING each pending array, so an entry appended after this point (a
 * classifier still in flight) accumulates afresh and lands on the next flush rather than being
 * written twice. That is the whole concurrency story: no marks, no coordination, and eventual
 * delivery — which is all a log needs, since each entry names the turn that caused it.
 *
 * Anchored on the turn's head (its user message) because that is the message a retract-and-rerun
 * keeps; assistant and tool messages are popped into a retraction marker where no reduction over
 * `session.messages` would find them again. An entry whose turn head has since gone (a session
 * edit, a compaction) is dropped rather than orphaned onto an unrelated message.
 */
export async function flushUsage(store: Store<Session>, id: string, s: SessionState): Promise<void> {
  // Splice each array in place and KEEP the references. Dropping a drained array is the obvious
  // tidy-up and it silently loses exactly the case this exists for: a classifier that settles after
  // the flush appends to the array its scope captured, so if the pump has stopped holding it, the
  // write goes nowhere observable. They are left registered for the life of the session state, at a
  // cost of one empty array per turn.
  //
  // The limit of that: `maybeCleanup` disposes the state once the session is quiet and unsubscribed,
  // so a completion still in flight at THAT point is lost. This is the carrier's stated best-effort
  // contract rather than a hole to plug — nothing can know what is still pending — and it is bounded
  // in practice, since the two channels that settle late (a `followup` hook, a user-phase classifier
  // the runner polls) are both awaited inside the pump iteration this scope wraps.
  const drained = s.pendingUsage.flatMap(entries => entries.splice(0));
  if (drained.length === 0) return;

  const session = await store.get(id);
  if (!session) return;

  // Anchor on the entry's own turn head when it has one, and on its ROOT's otherwise. A
  // retract-and-rerun re-runs an existing user turn under a fresh traceId and introduces no user
  // message, so its entries have no head of their own — and the root is the honest home anyway, since
  // a retry's cost belongs to the turn being retried. Without this the redo's spend was dropped
  // outright, which is the very under-report anchoring on the turn head exists to prevent.
  const heads = new Set(session.messages.filter(m => m.role === 'user').map(m => m.traceId));
  const byTrace = new Map<string, TurnEntry[]>();
  for (const e of drained) {
    const anchor = e.traceId !== undefined && heads.has(e.traceId) ? e.traceId : e.rootTraceId;
    if (anchor === undefined || !heads.has(anchor)) continue;
    const list = byTrace.get(anchor);
    if (list) list.push(e); else byTrace.set(anchor, [e]);
  }

  let changed = false;
  const messages = session.messages.map(m => {
    const add = m.role === 'user' ? byTrace.get(m.traceId) : undefined;
    if (add === undefined) return m;
    byTrace.delete(m.traceId);
    changed = true;
    return { ...m, activity: [...(m.activity ?? []), ...add] };
  });
  if (!changed) return;
  await store.set(id, { ...session, messages });
}

// Between turns: nothing holds the session but the pump itself, so a settled parallel reply is simply
// appended — after the turn it ran beside, which by now has committed.
export async function drainMerges(store: Store<Session>, id: string, s: SessionState): Promise<void> {
  if (s.merges.length === 0) return;
  // One `placeNow` already wrote is in the store and was announced then; it stayed on the list only so
  // a running turn's in-memory session would pick it up, and there is no running turn here.
  const taken = s.merges.splice(0).filter(r => r.persisted !== true);
  if (taken.length === 0) return;
  const session = await store.get(id);
  if (session === null) return;
  // And one whose `placeNow` is still in flight has no flag set yet, so the id is the authority: every
  // placement path is idempotent on it, and whichever gets there first is the one that announces.
  const have    = new Set(session.messages.map(m => m.id));
  const replies = taken.filter(r => !have.has(r.messages[0].id));
  if (replies.length === 0) return;
  try {
    await store.set(id, replies.flatMap(r => r.messages).reduce(appendMessage, session));
  } catch (e) {
    if (!isReadOnlyError(e)) throw e;
    for (const r of replies) notify(s, { type: 'error', error: e.message, traceId: r.traceId });
    return;
  }
  for (const r of replies) notify(s, { type: 'merged', traceId: r.traceId });
}

// Between turns, too: the writes that were waiting for no turn to hold the session. One at a time, in
// the order they came, each reading the document for itself, so each sees the one before it — two
// writes of one session never race each other. Never throws (see `write`).
export async function drainWrites(s: SessionState): Promise<void> {
  for (let w = s.writes.shift(); w !== undefined; w = s.writes.shift()) await w();
}

// While a turn runs: called by runSession at the top of each round. The pair goes AHEAD of the running
// turn's own messages, where the copy the parallel turn ran on ended — so the history stays exactly
// what that reply was generated against, and alternates without help. At the tail, after the latest
// tool result, the reply would be the last message of the turn's next provider call (a prefill), and
// once the turn answered, two adjacent assistant messages, which the adapters fold into one — putting
// text ahead of a `thinking` block. Each later pair lands after the earlier ones, so they stay in order.
export const interjectInto = (s: SessionState) => (cur: Session): { session: Session; merged: string[] } | undefined => {
  if (s.merges.length === 0 || s.turnHead === undefined) return undefined;
  const head = s.turnHead.id;
  const at = cur.messages.findIndex(m => m.id === head);
  if (at < 0) return undefined;
  const replies = s.merges.splice(0);
  s.interjected.push(...replies);
  // Only what is not already here. `placeNow` may have written a pair while a PREVIOUS turn's followup
  // hooks ran, and this turn (a redo, or whatever followup enqueued) then read a session that already
  // contains it — so splicing the list wholesale would duplicate the pair. The id is the authority, the
  // same way it is in `placeNow` and `drainMerges`.
  const have = new Set(cur.messages.map(m => m.id));
  const add  = replies.flatMap(r => r.messages).filter(m => !have.has(m.id));
  return {
    session: { ...cur, messages: [...cur.messages.slice(0, at), ...add, ...cur.messages.slice(at)] },
    // A reply `placeNow` wrote announced itself then. It still has to reach the turn's in-memory
    // session — that is the whole reason it is on this list — but announcing it twice would make a
    // frontend place the same pair twice.
    merged:  replies.filter(r => r.persisted !== true).map(r => r.traceId),
  };
};

/**
 * A whole-document rewrite of a session whose turn has already committed — the `followup` writes. The
 * pump used to be the only writer at that point, so an unconditional `set` was safe; it no longer is,
 * because `placeNow` may insert a settled parallel pair while the hooks are judging. So these compare
 * against the document the hooks were shown and rebuild from `current` if it moved, which costs no read
 * at all on the uncontended path — a re-read would cost one per turn, and would also consume the next
 * `store.get`, which is a thing tests legitimately hold.
 *
 * `build` is called once per attempt and must therefore derive everything from the document it is given.
 * Giving up is logged rather than thrown: the turn has committed, and the caller decides what a write it
 * could not make means (the retraction does not enqueue a redo it never wrote).
 */
export async function rewrite(
  store: Store<Session>, id: string, from: Session, build: (cur: Session) => Session, lost: string,
): Promise<boolean> {
  let cur = from;
  for (let n = 0; n < WRITE_ATTEMPTS; n++) {
    const res = await store.cas(id, cur.version, build(cur));
    if (res.ok) return true;
    if (res.current === null) break;
    cur = res.current;
  }
  console.error(lost);
  return false;
}

/**
 * Place a settled parallel reply in the store NOW, while a turn is still running, rather than leaving
 * it to that turn's next round boundary. A turn parked in one long tool call reaches no boundary, so
 * the pair used to exist in no store, no replay and no stream until the tool returned — a client that
 * reconnected in that window could not see it at all, and the pair is a COMPLETED turn, not a partial
 * one: nothing about it is waiting to be finished.
 *
 * The runner still owns the session exclusively. The pair is handed to the running turn as well
 * (`interjectInto`, and the final pull in `end`), so that turn's whole-document write-back carries it
 * instead of erasing it. Placed ahead of the running turn's head, exactly where `interjectInto` puts
 * it, so the two never disagree about where the pair goes.
 *
 * CAS rather than `set`, because the running turn commits with a whole-document write of its own:
 * losing the compare is how we learn it landed, and `current` is what it wrote.
 *
 * Three outcomes, because the pair is on `merges` before this runs and so EVERY placement path may
 * reach it — this one, `interjectInto` at a round boundary, `drainMerges` once the turn is over. They
 * are mutually idempotent on the pair's own message id, and exactly one of them inserts it: `present`
 * says somebody else did, and is why this does not announce a `merged` the other path already sent.
 */
export async function placeNow(store: Store<Session>, id: string, reply: ParallelReply): Promise<'inserted' | 'present' | 'no'> {
  if (reply.head === undefined) return 'no';
  let cur = await store.get(id);
  for (let n = 0; n < WRITE_ATTEMPTS; n++) {
    if (cur === null) return 'no';
    if (cur.messages.some(m => m.id === reply.messages[0].id)) return 'present';
    // The reply's OWN head, not the session's current one: a parallel turn submitted during a turn's
    // `followup` ran on a copy that INCLUDED that finished turn, so its pair belongs after it, and
    // `s.turnHead` would have put it in front of the very history it answered. Resolved per attempt,
    // since a lost compare hands us a different document.
    const at = cur.messages.findIndex(m => m.id === reply.head);
    // The head is not in the store yet (it is persisted just after it is set), or a retract has since
    // popped it: either way there is nothing here to place against. Leave it to the turn or the pump.
    if (at < 0) return 'no';
    const next = { ...cur, messages: [...cur.messages.slice(0, at), ...reply.messages, ...cur.messages.slice(at)] };
    try {
      const res = await store.cas(id, cur.version, next);
      if (res.ok) return 'inserted';
      cur = res.current;
    } catch (e) {
      // A shared session this principal may only read. The turn's own placement reports it (drainMerges
      // / the turn's commit); claiming nothing was written is what lets that path run unchanged.
      if (!isReadOnlyError(e)) throw e;
      return 'no';
    }
  }
  return 'no';
}
