/**
 * The two pluggable judgement interfaces dream-time delegates to.
 *
 * Everything else in dream-time is deterministic TypeScript. These two interfaces are the only
 * places "judgement" lives — and even they are narrowly scoped:
 *
 *   - {@link Ranker} produces numeric scores over (fact, skill) pairs. The pipeline owns what
 *     those scores mean (thresholds, cluster definition, blocklist application). Today's only
 *     implementation will be LLM-backed via `singleTurn`; tomorrow's could be embedding cosine,
 *     a small classifier, or a hand-rolled keyword heuristic, with no pipeline changes.
 *
 *   - {@link Merger} edits prose: splice a fact into a skill's markdown, preserve the rest, flag
 *     contradictions. This is the one step that genuinely requires natural-language reasoning,
 *     and a non-LLM implementation is not on any near horizon — but keeping it behind an
 *     interface costs nothing and means the pipeline test-doubles cleanly.
 *
 * Both interfaces are deliberately small: one method each, pure inputs in / structured output
 * out, no hidden dependencies on the platform's services object. The implementations are free
 * to capture whatever they need (a `MatbotMachine`, a provider name, a model handle) in their
 * constructors. The pipeline only sees the interface.
 */

import type { RememberedFact, SkillCandidate, Score, MergeResult } from './types.js';

// ── Ranker ────────────────────────────────────────────────────────────────────

/**
 * Score every (fact, skill) pair in the cross-product of the two inputs.
 *
 * The pipeline calls this once per `runOnce()` pass, with:
 *   - `facts`: every still-unassigned fact (those without a `dreamSkill` field), capped at a
 *     pipeline-side limit so the input is bounded.
 *   - `skills`: every skill NOT in the configured blocklist, with the metadata view the ranker
 *     can actually use (no full prose).
 *
 * The output is a flat array of {@link Score}s — one per (fact, skill) pair, in any order. The
 * pipeline indexes into the result by `(factId, skill)` so the ranker is free to batch, parallelise,
 * or reorder however it likes. Missing pairs (a ranker that decides early some skill can't
 * possibly fit any fact) are treated as score 0 by the pipeline; rankers should prefer returning
 * an explicit 0 with a one-line reasoning so the omission is observable.
 *
 * `signal` is the usual cancellation channel. Long-running rankers MUST honour it; the pipeline
 * propagates aborts (from the tool-call cancellation path) down.
 */
export interface Ranker {
  rank(
    facts:  readonly RememberedFact[],
    skills: readonly SkillCandidate[],
    signal: AbortSignal,
  ): Promise<readonly Score[]>;
}

// ── Merger ────────────────────────────────────────────────────────────────────

/**
 * Splice one fact into one skill's markdown. Called by the pipeline for every fact in the chosen
 * cluster (the primary plus any cluster-mates), sequentially: each call's output `content` is fed
 * as the next call's input `skillContent`, so a fact merged in step N is visible to the merger
 * when it considers contradiction-detection for the fact in step N+1.
 *
 * `skillName` is passed alongside `skillContent` for the merger's information (a prompt may refer
 * to "this skill"); the pipeline does not require the merger to round-trip the name. The pipeline
 * does the `SkillManager.save()` after all cluster members are merged, never partway through, so
 * a merger failure leaves the skill untouched.
 */
export interface Merger {
  merge(
    skillName:    string,
    skillContent: string,
    fact:         RememberedFact,
    signal:       AbortSignal,
  ): Promise<MergeResult>;
}
