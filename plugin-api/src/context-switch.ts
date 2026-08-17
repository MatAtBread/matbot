import type { Principal } from './types.js';
import { runAs } from './principal-context.js';
import { globalSlot } from './global-state.js';

/**
 * A context switch is the machine analogue of an OS one: it pages in any pending machine state and
 * sets the owner. {@link runAs} is the bare "set the owner" instruction (the principal carrier);
 * {@link machineBusy} is the other half — "hold the machine, I am mid-operation" — and
 * {@link contextSwitch} is the two together, for an operation that is both.
 *
 * Why deferral exists: a service like the `StorageBackend` is the system of record, and swapping it
 * under a running operation would split a compare-and-swap (or a turn) across two backends. So a
 * swap is queued and applied only at the *quiescent edge* — the instant nothing holds the machine.
 * The principal carrier stays a pure identity primitive; this module owns the machine half.
 *
 * **What counts as busy is the operation, not the turn.** The two are not the same thing, and
 * assuming they were is what made this edge wrong: a turn commits its session document, and *then*
 * its pump reads that document back, appends followup markers, rewrites it for a retract, and starts
 * the next queued turn — all of it store work outside the turn, and all of it quiescent under a
 * per-turn hold. A mutation landing in that window splits exactly what the deferral exists to keep
 * whole. So the pump holds the machine for its whole queue and switches principal per item, which is
 * also where accounting already flushes: "the end of a turn" is not a moment anything can be totalled
 * or swapped at, and the queue draining is.
 *
 * The host registers what to flush ({@link onContextQuiesce}). Entry points that receive work but do
 * not perform it — a web request holding an SSE stream open, a telegram message — use {@link runAs}
 * and are deliberately NOT busy: their scope spans a long-lived stream, and counting it would mean
 * the machine never reaches an edge at all. The boot principal (an `enter`, not a `run`) is likewise
 * never counted.
 */

// State-shaped and reachable from a plugin (a storage plugin registering a deferred-swap flusher, or
// holding the machine), so it lives in the global slot: a duplicated plugin-api copy shares one set
// of quiescers and one hold count rather than splitting them. See ./global-state.ts.
//
// `depth` keeps its name across the change of meaning — it counts machine holds now, of which a
// principal-bearing context switch is one — because the slot is shared by every loaded copy of this
// module, including published older ones. Both spellings of "busy" increment the same field, so a
// skewed install still agrees on when the machine is idle; a renamed field would have left an old
// copy marking a turn busy on `depth` while a new copy read `busy` and called the machine quiet.
interface ContextSwitchState {
  quiescers: Set<Quiescer>;
  depth:     number;
  flushing:  boolean;
  /** The flush currently settling, when a flusher went async. Held so a second caller joins the one
   *  in flight rather than starting a second, and so {@link quiesced} has something to wait on. */
  inflight?: Promise<void> | undefined;
}
const cs = globalSlot<ContextSwitchState>('context-switch', () => ({
  quiescers: new Set<Quiescer>(),
  depth:     0,
  flushing:  false,
}));

/**
 * A machine-update flush. Returning a promise makes the edge *wait*: the deferred work is no longer
 * merely started at the edge but finished before the machine is handed to whoever asked to be
 * quiesced first (see {@link quiesced}). That matters for work that reads and rewrites a document the
 * next operation is about to read — a store edge deferred out of a turn lands in the window before
 * the next turn takes its copy, or not at all.
 */
export type Quiescer = () => void | Promise<void>;

/**
 * Register a machine-update flush, run at every quiescent edge (nothing holding the machine).
 * Flushers MUST be idempotent: a no-op when nothing is pending, since the edge is reached after every
 * operation. Returns an unregister fn.
 *
 * What the edge guarantees a flusher:
 *
 * - Flushers are **invoked in registration order**, in one synchronous sweep; one that goes async is
 *   started in that order and then left to settle alongside the rest.
 * - **The synchronous prefix lands within the call.** As long as flushers are synchronous nothing
 *   yields at all, which is what lets the host stage a mutation and land it with a bare
 *   `flushIfQuiescent()` — in effect before the call returns.
 * - **No second sweep begins until the current one has completely settled**, and a mutation staged
 *   meanwhile is turned away rather than applied.
 * - A throwing flusher is isolated, and so is a rejecting one — neither may deny the others their
 *   completion, nor escape into the operation whose release happened to reach the edge.
 *
 * **It does not give exclusivity, and could not.** A synchronous flusher has it for free — the runtime
 * is single-threaded — and that is the argument for keeping a flusher synchronous whenever the work
 * allows. The moment one awaits, the window is open: `depth` is 0 while a flush settles, so an HTTP
 * endpoint can accept a request and run a tool call to completion inside a single `await`, and only an
 * operation that asked to be {@link quiesced} first (the pump) is held back. Flushers may therefore
 * overlap each other too, and sequencing them would buy nothing — it would remove one source of
 * concurrent mutation while leaving every other in place, at the price of every flusher waiting on the
 * slowest.
 *
 * So contention over a service is the *service's* to resolve, not the sweep's: a `Store` answers it
 * with compare-and-swap, and a subsystem with a stronger requirement owns a stronger answer. The
 * sweep's job is to make contention rare, not to pretend the machine stops.
 *
 * **Known gap, not caused here.** Compare-and-swap answers "did this document change?", not "did the
 * medium change?" — a read from one `StorageBackend` and a write to another compares a version from
 * the first against the second, and a session migrates with nothing in a position to notice. Staging
 * a swap rather than applying it while a flush settles narrows that window, but it is a mitigation
 * in the wrong place: an HTTP tool call has always been able to straddle a swap the same way, so the
 * exposure predates asynchronous flushers and is merely easier to reach with them. The fix belongs
 * where the consequence lands — a `cas` that checks the backend it is writing to is the one it read
 * from, and fails when it is not.
 *
 * The keys that repoint *immediately* — `Vault`, `KnowledgeIndex`, `Notifier`, anything a plugin
 * registers — carry no protection here or anywhere: they change under a running turn too, by the
 * design decision that only the system of record is worth deferring. A flusher that depends on one
 * should resolve it once rather than either side of an await, exactly as a turn should.
 */
export function onContextQuiesce(flush: Quiescer): () => void {
  cs.quiescers.add(flush);
  return () => { cs.quiescers.delete(flush); };
}

/**
 * Run the registered flushers iff nothing holds the machine — the quiescent edge. Called by
 * {@link machineBusy} at both edges, and by the host right after it *queues* a deferred mutation:
 * queued while busy (depth > 0) this no-ops and the release edge lands it; queued while idle (depth 0)
 * it applies immediately, so an idle-time swap doesn't wait for the next request to take effect.
 *
 * Returns the settling promise when some flusher went async, and `undefined` when the edge is already
 * complete — the caller decides whether it can afford to wait ({@link quiesced} does; a synchronous
 * caller cannot). Re-entering while one is settling joins it rather than starting a second: `flushing`
 * stays raised for the whole asynchronous extent, not just the synchronous sweep.
 */
export function flushIfQuiescent(): Promise<void> | undefined {
  if (cs.depth !== 0 || cs.flushing) return cs.inflight;
  cs.flushing = true;

  // Snapshot: a one-shot flusher unregisters itself as it fires, and a flusher may register another.
  // Iterating a copy makes both safe and settles what a mid-sweep registration means — it was not
  // registered when this edge began, so it runs at the next one.
  const settling = [...cs.quiescers]
    .map(q => {
      // A synchronous throw is the flusher's own business, never that of the operation whose release
      // happened to reach the edge. A rejection is handled below, by allSettled.
      try { return q() ?? undefined; }
      catch (e) { console.error('[matbot] context-quiesce flush threw:', e instanceof Error ? e.message : e); return undefined; }
    })
    .filter((p): p is Promise<void> => p !== undefined);

  if (settling.length === 0) {
    // Every flusher was synchronous, so the edge is complete on return — which is what lets the host
    // stage a mutation and land it with a bare `flushIfQuiescent()`, in effect before the call returns.
    cs.flushing = false;
    cs.inflight = undefined;
    return undefined;
  }

  // allSettled, not all: one flusher's rejection must not deny the others their completion, and the
  // aggregate must never reject — the release below depends on it, and there is nobody to catch it.
  const all = Promise.allSettled(settling).then(results => {
    for (const r of results) {
      if (r.status === 'rejected') console.error('[matbot] context-quiesce flush rejected:', r.reason instanceof Error ? r.reason.message : r.reason);
    }
    cs.flushing = false;
    cs.inflight = undefined;
  });
  cs.inflight = all;
  return all;
}

/**
 * Wait until the edge is not merely reached but *complete*: reach it, and let any deferred work it
 * starts (or finds already settling) finish. An operation that must not overlap deferred work — a turn
 * about to take its copy of a session that a previous turn's deferred edit is rewriting — awaits this
 * before holding the machine.
 *
 * **One pass, deliberately not a loop.** An `async` flusher returns a promise whether or not it had
 * anything to do — "nothing pending" is unobservable from out here, since an immediately-resolved
 * promise and a real unit of work are the same object to us. A loop that waited for a pass to produce
 * no promise would therefore never terminate against an idempotent async flusher, and neither would a
 * re-run scheduled after each settle: each pass would manufacture the evidence for the next. So work
 * staged *during* a flush lands at the following edge — the next `machineBusy` release, or the next
 * caller through here — which is all the mount contract has ever promised: eventual and ordered,
 * never timed.
 */
export async function quiesced(): Promise<void> {
  await flushIfQuiescent();
}

/**
 * Hold the machine for the extent of `fn`: land any pending mutation first (only safe while idle),
 * then keep the machine off-limits to further ones until `fn` is done. Mirrors {@link runAs}'s
 * sync/async return — when `fn` is async the hold stays up until its promise settles, so the count
 * tracks the real operation rather than the synchronous call.
 *
 * The hold is released on **every** exit — a synchronous throw, a rejected promise, a bare `return`
 * from anywhere inside — because the release is bound to the call, not written at the exits. That is
 * the whole reason this is a wrapper and not a `begin()`/`end()` pair: a caller with a dozen early
 * returns (the pump has several per queue item) cannot leave the counter stuck, and a stuck counter
 * is unrecoverable — every later flush would silently no-op forever, and the symptom would be a
 * deferred mutation that simply never happens.
 */
export function machineBusy<T>(fn: () => T): T {
  flushIfQuiescent();
  cs.depth++;
  let settled = false;
  const settle = (): void => {
    if (settled) return;   // the sync-throw path settles before rethrowing; never settle twice
    settled = true;
    cs.depth--;
    flushIfQuiescent();
  };
  let result: T;
  try {
    result = fn();
  } catch (e) {
    settle();
    throw e;
  }
  return result instanceof Promise ? (result.finally(settle) as T) : (settle(), result);
}

/**
 * Switch into the machine as `principal`: hold it for the extent of `fn` ({@link machineBusy}) and
 * run `fn` under the principal ({@link runAs}). The composition, for an operation that both owns the
 * machine and has an owner — a single-turn request standing on its own. An operation that decomposes
 * into differently-owned units (the pump: one queue, a principal per item) holds the machine once
 * around the whole of it and calls `runAs` per unit instead.
 */
export function contextSwitch<T>(principal: Principal, fn: () => T): T {
  return machineBusy(() => runAs(principal, fn));
}
