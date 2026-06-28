import type { Usage, UsageRecord } from './types.js';

/**
 * Ambient carrier for token accounting — the channel by which a completion run *inside a tool* (via
 * `MatbotRuntime.complete`/`singleTurn`) reports its usage back to the runner without that bookkeeping
 * being threaded through every tool, ranker, or merger signature. It mirrors the {@link PrincipalCarrier}:
 * a sink is established for an async extent, and code deep within (the host's `complete()`) appends to
 * whatever sink is in force via {@link recordUsage}.
 *
 * Why ambient. A tool reaches an LLM only through the core completion services — it cannot call a
 * provider directly. Recording at that one choke point therefore captures *every* tool's spend (a
 * `single_turn`, an `ask_inner_voice`, each of `dream_time`'s per-fact ranker/merger calls) with zero
 * per-tool code. The runner opens one sink per turn ({@link withUsageScope}) and slices it per tool
 * call, attributing each completion to the call that triggered it.
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
  /** Establish a fresh `sink` for the dynamic extent of `fn`. Consume any async iterable *inside* `fn`. */
  run<T>(sink: UsageRecord[], fn: () => T): T;
  /** The sink in force for the current async flow, or `undefined` outside any scope. */
  tryCurrent(): UsageRecord[] | undefined;
}

const CARRIER_KEY = Symbol.for('@matatbread/matbot-plugin-api#usageCarrier');
type CarrierGlobal = { [CARRIER_KEY]?: UsageCarrier };

/** Install the host's platform carrier. Called once at boot. */
export function installUsageCarrier(impl: UsageCarrier): void {
  (globalThis as CarrierGlobal)[CARRIER_KEY] = impl;
}

/** The usage sink in force, or `undefined` when no carrier is installed or no scope is established. */
export function currentUsageSink(): UsageRecord[] | undefined {
  return (globalThis as CarrierGlobal)[CARRIER_KEY]?.tryCurrent();
}

/** Append one provider call's usage to the sink in force. No-op outside any scope (best-effort accounting). */
export function recordUsage(provider: string, usage: Usage): void {
  currentUsageSink()?.push({ provider, usage });
}

/** Run `fn` with a fresh, empty usage sink established for its async extent. Passthrough when no carrier. */
export function withUsageScope<T>(fn: () => T): T {
  const carrier = (globalThis as CarrierGlobal)[CARRIER_KEY];
  if (carrier === undefined) return fn();
  return carrier.run([], fn);
}

/**
 * A carrier for realms with no async-context isolation (the browser, tests): a single module-global
 * sink, set on `run` and restored once `fn` settles. Correct as long as scopes do not truly overlap —
 * the same single-turn assumption the constant principal carrier makes.
 */
export function createSerialUsageCarrier(): UsageCarrier {
  let current: UsageRecord[] | undefined;
  return {
    run(sink, fn) {
      const prev = current;
      current = sink;
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
