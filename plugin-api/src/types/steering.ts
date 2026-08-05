import type { MessageContent, Session } from './messages.js';

// ── Steering ────────────────────────────────────────────────────────────────────

/** Disposition of a submission that arrives while a turn is running. `interrupt` stops the running
 *  turn (its committed partial work is preserved) and runs the new message next; `queue` waits for the
 *  turn boundary. */
export type SteeringDecision = 'queue' | 'interrupt';
/** The wire-level request (see `SubmitOpenOpts.mode`). `auto` defers the decision to the registered
 *  {@link SteeringPolicy} (else the host default). */
export type SteeringMode = SteeringDecision | 'auto';

/**
 * How the runner disposes of a mid-turn submission under `mode: 'auto'`, and how an interrupt's
 * continuation is nudged. An optional, registerable service ({@link MatbotServices}); absent ⇒ the
 * runner uses its own defaults. Both members are optional so a plugin may override one, the other, or
 * both. `classify` is deliberately NOT assumed to be an LLM — a regex or a semantic classifier is a
 * first-class implementation (return synchronously); an LLM `singleTurn` returns a promise.
 */
export interface SteeringPolicy {
  /**
   * Consulted only for `mode: 'auto'` while a turn is running. `session` is the COMMITTED session
   * (history up to the running turn's start — the in-flight partial is not reachable at submit time);
   * `steer` is the incoming submission. Return synchronously (regex) or async (semantic / singleTurn).
   * Absent ⇒ the host default disposition.
   */
  classify?(ctx: { session: Session; steer: MessageContent[] }): SteeringDecision | Promise<SteeringDecision>;
  /**
   * The ephemeral "keep going, noting the above" context folded onto an interrupt's continuation turn
   * (never persisted). Absent ⇒ the host default nudge.
   */
  nudge?(ctx: { session: Session; steer: MessageContent[] }): MessageContent[];
}
