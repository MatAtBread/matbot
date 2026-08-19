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
  /** Deferred work was staged while the machine was held, so the edge it needs was out of reach. Raised
   *  by {@link flushIfQuiescent} — which is only ever called by a stager — and lowered when a flush
   *  actually runs. While it is up, {@link machineBusy} bars new entrants so `depth` can reach 0. */
  wanted?:   boolean;
  /** Entrants parked at the barrier, woken on every release and at the end of every flush. */
  waiters?:  Array<() => void>;
}
const cs = globalSlot<ContextSwitchState>('context-switch', () => ({
  quiescers: new Set<Quiescer>(),
  depth:     0,
  flushing:  false,
}));

// The slot is shared by every loaded copy of this module, INCLUDING published copies older than the
// barrier — one of those may have created it, so the two fields above can be absent rather than merely
// false. Read them through here. A stager living in an old copy raises no `wanted`, so entry is not
// barred on its behalf: that is the pre-barrier behaviour (its work lands at the next natural release),
// not a broken one.
function waiters(): Array<() => void> {
  return (cs.waiters ??= []);
}

/** Nothing staged and nothing settling — the barrier is down and an entrant walks straight in. */
function clear(): boolean {
  return cs.wanted !== true && !cs.flushing;
}

function wake(): void {
  const parked = waiters();
  if (parked.length === 0) return;
  cs.waiters = [];
  for (const w of parked) w();
}

/**
 * A machine-update flush. Returning a promise makes the edge *wait*: the deferred work is no longer
 * merely started at the edge but finished before the machine is handed to whoever asked to be
 * quiesced first (see {@link quiesced}). That matters for work that reads and rewrites a document the
 * next operation is about to read — a store edge deferred out of a turn lands in the window before
 * the next turn takes its copy, or not at all.
 */
export type Quiescer = (unregister: () => void) => void | Promise<void>;

/**
 * Register work to run at a quiescent edge — the next moment nothing holds the machine. Returns an
 * unregister fn, and passes the same fn to the flusher.
 *
 * **Registering is all a stager does.** It announces the work, so the barrier engages and the edge is
 * guaranteed to arrive; there is no second call to remember. Two idioms, and between them they cover
 * everything in-tree:
 *
 * ```ts
 * // ONE-SHOT — "do this at the next edge". The closure holds the work, so there is no pending flag.
 * onContextQuiesce(un => { un(); applyTheThing(); });
 *
 * // REPEATED — "do this at every edge". Same thing without the un(), and then it MUST be idempotent:
 * onContextQuiesce(() => { if (nothingToDo) return; … });
 * ```
 *
 * Repeated announcements that should collapse into one apply — the host's staged `StorageBackend` swap, a
 * dirty mount key — are a guarded one-shot, which is {@link scheduleAtEdge}. Nothing in-tree registers a
 * standing flusher any more; the shape remains for "observe every edge", which needs no announcement at all.
 *
 * Note that continuous delivery is a *standing registration*, never a callback re-registering itself: see
 * {@link scheduleAtEdge} for why re-registration would re-enter the edge immediately and forever.
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
 * - **Exclusivity, for a flusher's whole extent.** A synchronous flusher has always had it for free —
 *   the runtime is single-threaded — and that remains the argument for keeping one synchronous whenever
 *   the work allows. An asynchronous one now has it too, because {@link machineBusy} bars entry while a
 *   flush is settling. Flushers still overlap *each other*, deliberately: sequencing them would remove
 *   one source of concurrent mutation while leaving every other in place, at the price of every flusher
 *   waiting on the slowest.
 *
 * Exclusivity is a recent acquisition and the reasoning that preceded it is worth keeping, because it
 * says what the barrier is really for. This edge used to be a counter, not a gate: `depth` was 0 while
 * a flush settled, so an HTTP endpoint could accept a request and run a whole tool call inside a single
 * `await`, and the conclusion drawn was that contention over a service is the *service's* to resolve —
 * a `Store` answers it with compare-and-swap — and that the sweep's job was only to make contention
 * rare rather than to pretend the machine stops.
 *
 * That is still true, and `mediumGuard` is the shipped form of it: a write whose read came from another
 * `StorageBackend` fails on the version stamp, so coherence does not depend on this module at all.
 * Which is precisely what makes the barrier safe to add. It is not the correctness mechanism; it is the
 * **liveness** one. A counter cannot force `depth` to reach 0, so under continuously overlapping holds —
 * several sessions on a busy server, each pump holding across its own queue — the edge simply never
 * arrives and staged work waits for an idle moment that never comes. A deferred session edit that never
 * lands, and a staged backend swap that never applies, are both failures with no symptom. Barring entry
 * is the only way to make the drain reachable, and exclusivity falls out of it for free.
 *
 * The keys that repoint *immediately* — `Vault`, `KnowledgeIndex`, `Notifier`, anything a plugin
 * registers — carry no protection here or anywhere: they change under a running turn too, by the
 * design decision that only the system of record is worth deferring. A flusher that depends on one
 * should resolve it once rather than either side of an await, exactly as a turn should.
 */
export function onContextQuiesce(flush: Quiescer): () => void {
  const unregister = (): void => { cs.quiescers.delete(flush); };
  cs.quiescers.add(flush);

  // **Registering IS announcing.** A stager should not have to also remember to ask for an edge: the one
  // plugin doing this in-tree registered a one-shot and never called `flushIfQuiescent`, so the barrier
  // never engaged on its behalf and its work depended on someone else happening to release. Two calls that
  // must be paired, where omitting the second is silent, is the shape this module exists to avoid.
  //
  // The barrier is raised synchronously (it invokes nothing) so it engages at once, while the edge ATTEMPT
  // waits for a microtask — a callback must not run before the statement registering it has finished, or a
  // one-shot reading anything initialised on that same line, `unregister` included, would see it missing.
  // Nothing depends on registration landing synchronously; the host's inline-landing guarantee is attached
  // to an explicit `flushIfQuiescent()`, which still has it.
  if (cs.depth !== 0 || cs.flushing) cs.wanted = true;
  void Promise.resolve().then(() => { if (cs.quiescers.has(flush)) flushIfQuiescent(); });

  return unregister;
}

/**
 * **Force the edge now if it can be reached, and announce the work if it cannot.**
 *
 * This was once how a caller told the edge that work existed, paired with a registration — and the one
 * plugin registering a one-shot never made the second call, so the barrier never engaged for it. Registering
 * announces now, which is the same guarantee with nothing to forget, and that leaves this doing only what
 * its name says. Nothing in-tree calls it; it is kept because "apply now if you are allowed to" is a
 * reasonable thing for a host to want, and because it is the only way to observe a sweep's settling promise
 * directly (which is what the tests want it for).
 *
 * It remains separate from the opportunistic sweep {@link machineBusy} performs at its own edges: only a
 * caller knows work exists, and a sweep that raised `wanted` merely because it found the machine busy would
 * bar every overlapping operation on behalf of nothing.
 *
 * Returns the settling promise when some flusher went async, and `undefined` when the edge is already
 * complete — the caller decides whether it can afford to wait ({@link quiesced} does; a synchronous
 * caller cannot). Re-entering while one is settling joins it rather than starting a second: `flushing`
 * stays raised for the whole asynchronous extent, not just the synchronous sweep.
 */
export function flushIfQuiescent(): Promise<void> | undefined {
  // Raised whenever this could not land the work — held, or a flush already settling. The settling case
  // matters as much as the held one: `depth` is 0 there, so nothing is coming to force another edge, and
  // an idle process would leave the work staged indefinitely.
  if (cs.depth !== 0 || cs.flushing) { cs.wanted = true; return cs.inflight; }
  return sweep();
}

/**
 * The sweep itself, without the announcement — {@link machineBusy}'s own edges, which are offering the
 * machine rather than asking for it.
 */
function sweep(): Promise<void> | undefined {
  if (cs.depth !== 0 || cs.flushing) return cs.inflight;
  cs.flushing = true;
  // Lowered here rather than on completion: every flusher has now been *offered* this edge, so anything
  // staged before it is accounted for. Work staged DURING the sweep re-raises it through the public
  // entry point above and is answered by the next edge — which is what the sweep already promised
  // ("a mutation staged meanwhile is turned away rather than applied").
  cs.wanted = false;

  // Snapshot: a one-shot flusher unregisters itself as it fires, and a flusher may register another.
  // Iterating a copy makes both safe and settles what a mid-sweep registration means — it was not
  // registered when this edge began, so it runs at the next one.
  const settling = [...cs.quiescers]
    .map(q => {
      // A synchronous throw is the flusher's own business, never that of the operation whose release
      // happened to reach the edge. A rejection is handled below, by allSettled.
      try { return q(() => { cs.quiescers.delete(q); }) ?? undefined; }
      catch (e) { console.error('[matbot] context-quiesce flush threw:', e instanceof Error ? e.message : e); return undefined; }
    })
    .filter((p): p is Promise<void> => p !== undefined);

  if (settling.length === 0) {
    // Every flusher was synchronous, so the edge is complete on return — which is what lets the host
    // stage a mutation and land it with a bare `flushIfQuiescent()`, in effect before the call returns.
    cs.flushing = false;
    cs.inflight = undefined;
    wake();
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
    // A stager that announced DURING this settle got `wanted` raised and no edge, and if the machine is
    // idle nothing else is coming to give it one. So answer it here — guarded, and therefore terminating:
    // only `flushIfQuiescent` raises `wanted`, and the sweep lowers it on entry, so an idempotent async
    // flusher (which returns a promise whether or not it had work) cannot manufacture the next round. That
    // is the distinction the "one pass, deliberately not a loop" note on `quiesced` turns on.
    if (cs.wanted === true && cs.depth === 0) sweep();
    wake();
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
 *
 * **Largely redundant since the barrier.** {@link machineBusy} now waits for staged work before it takes
 * the hold, which is this guarantee delivered where it cannot be forgotten — so the pump, the caller this
 * was written for, no longer calls it. It remains for an operation that needs deferred work complete and
 * does *not* want to hold the machine.
 */
export async function quiesced(): Promise<void> {
  await sweep();
}

/**
 * Run `work` at the next quiescent edge, **coalescing** repeated calls onto one edge. Returns the scheduler;
 * call it every time you stage something.
 *
 * The guarded one-shot, named — because the announcements a host makes are usually about a *slot* rather than
 * a queue: three `register('StorageBackend')` calls before an edge mean one backend to install, not three to
 * install in turn. Read the slot inside `work` and repeated stagings collapse for free, while one callback
 * keeps whatever `work` does in a fixed order.
 *
 * **Why continuous delivery is a standing registration and not this.** Registering means "I have work now",
 * which is what forces the edge — so a callback that re-registered itself would announce fresh work from
 * inside the sweep answering the last lot, and the edge would re-enter immediately and forever. A `setInterval`
 * cannot be built out of `setTimeout` here, because there is no independent clock to wait for: the edge is
 * driven by demand, and re-registration is unbounded demand. Want every edge? Register once and don't
 * unregister — and then be idempotent, since you will be called after every operation.
 */
export function scheduleAtEdge(work: () => void | Promise<void>): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    // Lowered before `work`, so work that itself stages more (a mount handler registering a service)
    // schedules a fresh edge rather than finding this one still claiming to be pending.
    onContextQuiesce(un => {
      un();
      scheduled = false;
      return work();
    });
  };
}

/** How long an entrant waits at the barrier before proceeding anyway. See {@link admit}. */
const ADMIT_TIMEOUT_MS = 2_000;

/**
 * The barrier: wait for staged work to land, then let the caller in.
 *
 * This is what makes the drain reachable. Without it `depth` is a counter that overlapping operations can
 * hold above zero indefinitely, and staged work waits for an idle moment that never arrives.
 *
 * **Bounded, because a counter cannot tell a nested entrant from a concurrent one.** An operation already
 * holding the machine that enters again — an LLM reaching a matbot HTTP endpoint through its own `http` or
 * `bash` tool, in-process, inside its own turn — would be waiting for a drain that includes its own outer
 * hold, and if the outer holder awaits the inner one that is a deadlock. Distinguishing the two needs a
 * hold-identity carrier (`AsyncLocalStorage` on node, something else in the browser) and the platform
 * split that implies; a bounded wait costs one constant and degrades to exactly the pre-barrier behaviour
 * instead of hanging. The warning is the diagnosis, since this is otherwise invisible.
 *
 * Giving up lowers `wanted`. Leaving it raised would make every subsequent entrant pay the full timeout
 * for one stuck round — a liveness aid turned into a throughput collapse — and the work is not lost: its
 * stager still holds it, and the next real edge lands it.
 */
async function admit(): Promise<void> {
  if (clear()) { sweep(); return; }        // the common path — and still an edge, as it always was
  const started = Date.now();
  for (;;) {
    if (cs.depth === 0) await sweep();     // the drain we were waiting for; land it here and now
    if (clear()) return;
    const waited = Date.now() - started;
    if (waited >= ADMIT_TIMEOUT_MS) {
      console.warn(
        `[matbot] entering the machine after waiting ${waited}ms for deferred work to land — it is still ` +
        `pending (${cs.quiescers.size} flusher(s), depth ${cs.depth}). If this repeats, an operation is ` +
        `holding the machine while waiting on something that needs it.`,
      );
      cs.wanted = false;
      return;
    }
    // The timer doubles as a poll: a missed wake-up would otherwise park an entrant until the next
    // unrelated release, and the whole point of this function is that progress does not depend on one.
    await new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, Math.min(25, ADMIT_TIMEOUT_MS - waited));
      waiters().push(done);
    });
  }
}

/**
 * Hold the machine for the extent of `fn`: wait for any staged mutation to land, then keep the machine
 * off-limits to further ones until `fn` is done. When `fn` is async the hold stays up until its promise
 * settles, so the count tracks the real operation rather than the synchronous call.
 *
 * **Always a promise, because entry can wait** ({@link admit}) — that is the barrier, and it is in here
 * rather than at the call site on purpose. An explicit "wait, then hold" pair reads better and puts the
 * cost in view, but it makes the waiting *optional*, and a second caller who omits it gets no error and
 * no symptom: staged work simply stops landing. That is the failure this whole module exists to prevent,
 * so it is not one to leave to a caller's memory — the same reasoning that makes the principal ambient
 * rather than threaded, and binds a mount interest to its plugin's load extent.
 *
 * When nothing is staged, `fn` still runs **synchronously** within the call, before the returned promise
 * is handed back: the barrier adds a hold, never a scheduling gap, so nothing can slip between the check
 * and the hold. A synchronous throw becomes a rejection, so the two paths report failure identically.
 *
 * The hold is released on **every** exit — a throw, a rejected promise, a bare `return` from anywhere
 * inside — because the release is bound to the call, not written at the exits. That is the whole reason
 * this is a wrapper and not a `begin()`/`end()` pair: a caller with a dozen early returns (the pump has
 * several per queue item) cannot leave the counter stuck, and a stuck counter is unrecoverable — every
 * later flush would silently no-op forever, and the symptom would be a deferred mutation that simply
 * never happens.
 */
export function machineBusy<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!clear()) return admit().then(() => held(fn));
  // Nothing staged, so this entry is itself an edge — as it always was. If the sweep settles inline the
  // hold goes up within this call; if a flusher went async we wait for it, which is the guarantee the
  // pump used to spell as `quiesced()`: deferred work that rewrites a document must finish before the
  // next operation reads it, not merely have been started.
  const settling = sweep();
  return settling === undefined ? held(fn) : settling.then(() => held(fn));
}

function held<T>(fn: () => T | Promise<T>): Promise<T> {
  cs.depth++;
  let settled = false;
  const settle = (): void => {
    if (settled) return;   // the throw path settles before rejecting; never settle twice
    settled = true;
    cs.depth--;
    sweep();
    wake();                // a release is a chance for anyone parked at the barrier to get in
  };
  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (e) {
    settle();
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  return result instanceof Promise ? result.finally(settle) : (settle(), Promise.resolve(result));
}

/**
 * Switch into the machine as `principal`: hold it for the extent of `fn` ({@link machineBusy}) and
 * run `fn` under the principal ({@link runAs}). The composition, for an operation that both owns the
 * machine and has an owner — a single-turn request standing on its own. An operation that decomposes
 * into differently-owned units (the pump: one queue, a principal per item) holds the machine once
 * around the whole of it and calls `runAs` per unit instead.
 */
export function contextSwitch<T>(principal: Principal, fn: () => T | Promise<T>): Promise<T> {
  return machineBusy(() => runAs(principal, fn));
}
