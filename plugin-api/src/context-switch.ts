import type { Principal } from './types.js';
import { runAs } from './principal-context.js';
import { globalSlot } from './global-state.js';

/**
 * A context switch is the machine analogue of an OS one: it pages in any pending machine state and
 * sets the owner. {@link runAs} is the bare "set the owner" instruction (the principal carrier);
 * {@link contextSwitch} is the scheduler operation layered on top — it also lands any machine
 * mutation that was deferred while the machine was busy.
 *
 * Why deferral exists: a service like the `StorageBackend` is the system of record, and swapping it
 * under a running operation would split a compare-and-swap (or a turn) across two backends. So a
 * swap is queued and applied only at the *quiescent edge* — the instant no context is active — which
 * is exactly a context-switch boundary. The principal carrier stays a pure identity primitive; this
 * module owns the machine-update half, so the two concerns share call sites without sharing code.
 *
 * The host registers what to flush ({@link onContextQuiesce}); the three entry points (a web
 * request, a telegram message, a turn) switch context through {@link contextSwitch} instead of
 * calling {@link runAs} directly. The boot principal (an `enter`, not a `run`) is the depth-0
 * baseline and is never counted.
 */

// State-shaped and reachable from a plugin (a storage plugin registering a deferred-swap flusher, or
// switching context), so it lives in the global slot: a duplicated plugin-api copy shares one set of
// quiescers and one depth count rather than splitting them. See ./global-state.ts.
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
 * Run the registered flushers iff no context is currently active — the quiescent edge. Called by
 * {@link contextSwitch} at both edges, and by the host right after it *queues* a deferred mutation:
 * queued while busy (depth > 0) this no-ops and the exit edge lands it; queued while idle (depth 0)
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
 * Switch into the machine as `principal`: land any pending machine mutation (only safe while idle),
 * then run `fn` under the principal. Mirrors {@link runAs}'s sync/async return — when `fn` is async,
 * the context stays open until its promise settles, so the depth count tracks the real operation.
 */
export function contextSwitch<T>(principal: Principal, fn: () => T): T {
  flushIfQuiescent();
  cs.depth++;
  const settle = (): void => { cs.depth--; flushIfQuiescent(); };
  let result: T;
  try {
    result = runAs(principal, fn);
  } catch (e) {
    settle();
    throw e;
  }
  return result instanceof Promise ? (result.finally(settle) as T) : (settle(), result);
}
