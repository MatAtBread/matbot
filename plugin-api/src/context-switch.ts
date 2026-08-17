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
  quiescers: Set<() => void>;
  depth:     number;
  flushing:  boolean;
}
const cs = globalSlot<ContextSwitchState>('context-switch', () => ({
  quiescers: new Set<() => void>(),
  depth:     0,
  flushing:  false,
}));

/**
 * Register a machine-update flush, run at every quiescent edge (no context active). Flushers MUST be
 * idempotent: a no-op when nothing is pending, since the edge is reached after every operation.
 * Returns an unregister fn. A throwing flusher is isolated — one must not block the others or escape
 * into the operation that triggered the edge.
 */
export function onContextQuiesce(flush: () => void): () => void {
  cs.quiescers.add(flush);
  return () => { cs.quiescers.delete(flush); };
}

/**
 * Run the registered flushers iff nothing holds the machine — the quiescent edge. Called by
 * {@link machineBusy} at both edges, and by the host right after it *queues* a deferred mutation:
 * queued while busy (depth > 0) this no-ops and the release edge lands it; queued while idle (depth 0)
 * it applies immediately, so an idle-time swap doesn't wait for the next request to take effect.
 */
export function flushIfQuiescent(): void {
  if (cs.depth !== 0 || cs.flushing) return;
  cs.flushing = true;
  try {
    for (const q of cs.quiescers) {
      try { q(); }
      catch (e) { console.error('[matbot] context-quiesce flush threw:', e instanceof Error ? e.message : e); }
    }
  } finally {
    cs.flushing = false;
  }
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
