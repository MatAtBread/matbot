/**
 * The pluggable judgement interfaces dream-time delegates to.
 *
 * Everything else in dream-time is deterministic TypeScript. These interfaces are the only
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
 *   - {@link Clusterer} groups the backlog — facts no skill took — into topics, and {@link SkillWriter}
 *     writes a candidate skill from one group. An embedding clusterer could replace the LLM one.
 *
 * All are deliberately small: one method each, pure inputs in / structured output
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
 * Splice facts into one skill's markdown. The ranking path calls it with one fact at a time, in sequence:
 * each call's output `content` is fed as the next call's input `skillContent`, so a fact merged in step N
 * is visible to the merger when it considers contradiction-detection for the fact in step N+1. Clustering
 * calls it once with a whole group, which is one whole-skill rewrite rather than one per fact.
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
    facts:        readonly RememberedFact[],
    signal:       AbortSignal,
  ): Promise<MergeResult>;
}

// ── Clusterer ─────────────────────────────────────────────────────────────────

/** One group a {@link Clusterer} proposes. `home` names an existing skill the group belongs in after all
 *  (the ranker missed it, say, because that skill's summary did not mention the topic), or is `null` for a
 *  group that needs a skill of its own. `members` are fact ids from the input. `asked` is a message a user
 *  might send that would call for the new skill: a skill is reached by search on what a message names, so a
 *  subject no message would name is never consulted, and a new group without one is not a skill. */
export interface FactGroup {
  name:    string;
  scope:   string;
  asked:   string;
  home:    string | null;
  members: string[];
}

/**
 * Group backlogged facts — sound facts no skill took after several rankings — into topics. Shown the
 * existing skills, so a group can be given an existing home, and the names of skills the backlog was
 * orphaned from (deleted, or rejected candidates), which it should not propose again. Leaves out what
 * fits no group. The pipeline validates the answer: unknown ids, a fact in two groups, a `home` that is
 * not a skill, a new group with no `asked` and an undersized new group are all dropped there, so an
 * implementation need not police it.
 */
export interface Clusterer {
  cluster(
    facts:    readonly RememberedFact[],
    skills:   readonly SkillCandidate[],
    rejected: readonly string[],
    signal:   AbortSignal,
  ): Promise<readonly FactGroup[]>;
}

/** Write a new skill's markdown from the facts of one group: the skill material among them, and nothing else.
 *  `undefined` when none of them is skill material, so no candidate is made and the facts stay in the backlog.
 *  It is the writer that declines, not the clusterer, because it judges one group's facts with the group in
 *  view, where the clusterer judges hundreds at once; and declining loses nothing, where retiring would. */
export interface SkillWriter {
  write(group: FactGroup, facts: readonly RememberedFact[], signal: AbortSignal): Promise<string | undefined>;
}
