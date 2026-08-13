import type { ISODate, TurnEntry, Usage, UsageSite } from './types.js';

/**
 * The accounting bag for one turn (or one sub-turn): the entries recorded within it, the call site in
 * force, and the parent it rolls up into. One object, carried ambiently, accumulating a *log* rather
 * than a fold — per-provider totals are a derived view (`usageByProvider`), and folding at write time
 * would bake in one grouping and destroy the others. See docs/ACCOUNTING-RATIONALE.md.
 */
export interface UsageScope {
  entries:  TurnEntry[];
  site?:    UsageSite;
  /** The turn this scope accounts for; stamped onto every entry recorded within it. */
  traceId?: string;
  parent?:  UsageScope;
}

/**
 * Ambient carrier for token accounting — the channel by which a completion run *inside a tool* (via
 * `MatbotRuntime.complete`/`singleTurn`) reports its usage back to the runner without that bookkeeping
 * being threaded through every tool, ranker, or merger signature. It mirrors the {@link PrincipalCarrier}:
 * a scope is established for an async extent, and code deep within (the host's `complete()`) appends to
 * whatever scope is in force via {@link recordUsage}.
 *
 * Why ambient. A tool reaches an LLM only through the core completion services — it cannot call a
 * provider directly. Recording at that one choke point therefore captures *every* tool's spend (a
 * `single_turn`, an `ask_inner_voice`, each of `dream_time`'s per-fact ranker/merger calls) with zero
 * per-tool code. The runner opens one scope per turn ({@link withUsageScope}) and labels the work
 * within it ({@link withUsageSite}), so each record carries the call site that produced it.
 *
 * The same ambience is what makes attribution correct rather than approximate: a carrier captures at
 * continuation creation, so a completion kicked off inside a `screen` hook and awaited long afterwards
 * still reports the site it *started* from, not whatever was running when it happened to resolve.
 *
 * The host installs one platform implementation at boot:
 *   - node (concurrent turns): an `AsyncLocalStorage`-backed carrier, so overlapping turns keep
 *     separate sinks (see the node app's `createAlsUsageCarrier`).
 *   - browser / single-turn realms: {@link createSerialUsageCarrier} — a set-and-restore global,
 *     correct while turns do not truly overlap (the same realm the constant principal carrier assumes).
 *
 * Capture is best-effort accounting: with no carrier installed (e.g. tests), {@link recordUsage} and
 * {@link currentUsageSink} are no-ops and usage simply isn't recorded — never an error.
 */
export interface UsageCarrier {
  /** Establish `scope` for the dynamic extent of `fn`. Consume any async iterable *inside* `fn`. */
  run<T>(scope: UsageScope, fn: () => T): T;
  /** The scope in force for the current async flow, or `undefined` outside any scope. */
  tryCurrent(): UsageScope | undefined;
}

const CARRIER_KEY = Symbol.for('@matatbread/matbot-plugin-api#usageCarrier');
type CarrierGlobal = { [CARRIER_KEY]?: UsageCarrier };

/** Install the host's platform carrier. Called once at boot. */
export function installUsageCarrier(impl: UsageCarrier): void {
  (globalThis as CarrierGlobal)[CARRIER_KEY] = impl;
}

/** The usage scope in force, or `undefined` when no carrier is installed or none is established. */
export function currentUsageScope(): UsageScope | undefined {
  return (globalThis as CarrierGlobal)[CARRIER_KEY]?.tryCurrent();
}

/** The entries of the scope in force. `undefined` outside any scope. */
export function currentUsageSink(): TurnEntry[] | undefined {
  return currentUsageScope()?.entries;
}

/** The call site in force, or `undefined` when none has been established. */
export function currentUsageSite(): UsageSite | undefined {
  return currentUsageScope()?.site;
}

/**
 * Append one provider call's usage to the scope in force, stamped with the call site in force. No-op
 * outside any scope (best-effort accounting).
 */
export function recordUsage(provider: string, usage: Usage, span?: { startedAt: ISODate; durationMs: number }): void {
  const scope = currentUsageScope();
  if (scope === undefined) return;
  scope.entries.push({
    kind: 'call', provider, usage,
    ...(scope.site    !== undefined ? { site:    scope.site    } : {}),
    ...(scope.traceId !== undefined ? { traceId: scope.traceId } : {}),
    ...(span          !== undefined ? span : {}),
  });
}

/**
 * Record a bracket matbot held open that was not a provider call — a tool call. Takes the site
 * explicitly rather than reading the ambient one, because the caller records this *after* the scope it
 * measured has closed.
 */
export function recordSpan(site: UsageSite, startedAt: ISODate, durationMs: number): void {
  const scope = currentUsageScope();
  if (scope === undefined) return;
  scope.entries.push({
    kind: 'span', site, startedAt, durationMs,
    ...(scope.traceId !== undefined ? { traceId: scope.traceId } : {}),
  });
}

/**
 * Run `fn` with a fresh usage scope established for its async extent, handing the scope to `fn` so the
 * caller can read what accrued. Passthrough (no scope) when no carrier is installed.
 *
 * Scopes **nest**: opened inside another, the child accumulates its own entries and rolls them up into
 * the parent when `fn` settles — so a sub-turn can be asked what it cost without its spend vanishing
 * from the turn containing it. Roll-up happens on rejection too: the tokens were spent either way.
 */
export function withUsageScope<T>(fn: (scope: UsageScope) => T, traceId?: string): T {
  const carrier = (globalThis as CarrierGlobal)[CARRIER_KEY];
  if (carrier === undefined) return fn({ entries: [], ...(traceId !== undefined ? { traceId } : {}) });
  const parent = carrier.tryCurrent();
  const trace  = traceId ?? parent?.traceId;
  const scope: UsageScope = {
    entries: [],
    ...(trace  !== undefined ? { traceId: trace } : {}),
    ...(parent !== undefined ? { parent } : {}),
  };
  const rollUp = (): void => { if (parent !== undefined) parent.entries.push(...scope.entries); };
  return carrier.run(scope, () => {
    const r = fn(scope);
    if (r instanceof Promise) return r.finally(rollUp) as unknown as T;
    rollUp();
    return r;
  });
}

/**
 * Run `fn` with `site` established as the call site, sharing the enclosing scope's entries — a *label*,
 * not a new bag. Pushed by the runner around its own provider call and around each tool executor, and
 * by the hook registry around each handler: the three places a completion can originate. Passthrough
 * when no carrier or no enclosing scope, so a site never conjures a bag that would be dropped.
 */
export function withUsageSite<T>(site: UsageSite, fn: () => T): T {
  const carrier = (globalThis as CarrierGlobal)[CARRIER_KEY];
  const parent  = carrier?.tryCurrent();
  if (carrier === undefined || parent === undefined) return fn();
  return carrier.run({ ...parent, site }, fn);
}

/**
 * A carrier for realms with no async-context isolation (the browser, tests): a single module-global
 * sink, set on `run` and restored once `fn` settles. Correct as long as scopes do not truly overlap —
 * the same single-turn assumption the constant principal carrier makes.
 */
export function createSerialUsageCarrier(): UsageCarrier {
  let current: UsageScope | undefined;
  return {
    run(scope, fn) {
      const prev = current;
      current = scope;
      try {
        const r = fn();
        if (r instanceof Promise) {
          return r.finally(() => { current = prev; }) as unknown as ReturnType<typeof fn>;
        }
        current = prev;
        return r;
      } catch (e) {
        current = prev;
        throw e;
      }
    },
    tryCurrent: () => current,
  };
}
