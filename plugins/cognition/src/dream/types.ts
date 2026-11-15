/**
 * Data shapes for the Dream-time consolidation pass.
 *
 * Dream-time is a deterministic TypeScript pipeline that gathers facts and skill metadata, asks a
 * pluggable {@link Ranker} to score (fact, skill) pairs, applies configured thresholds to turn
 * scores into routing decisions, and — for facts that route strongly — asks a pluggable
 * {@link Merger} to splice the fact into the chosen skill's prose. Everything except the ranking
 * and the prose-edit is plain TS: fetch, filter, sort, threshold, batch, CAS-write, record.
 *
 * The LLM is one current implementation behind those two interfaces. It is NOT the pipeline's
 * driver. The shapes below are designed so that swapping in an embedding-based ranker, a small
 * classifier, or anything else requires no changes outside `./ranker.ts`.
 */

// ── Skill metadata, as the pipeline passes it to the ranker ───────────────────

/**
 * The trimmed, ranker-facing view of a skill. Carries only what is needed to score a fact against
 * the skill — its name (for the result) and its derived metadata (the actual signal).
 *
 * `summary` / `entities` / `tags` come from `SkillDoc.knowledge`, which the skills plugin populates
 * on write. The pipeline treats missing metadata as a hard error, not a runtime branch: it is the
 * skills layer's job to keep metadata current. We pass the trimmed shape (rather than `SkillDoc`)
 * so the ranker contract doesn't drift if `SkillDoc` grows new fields, and so an embedding ranker
 * can read exactly the same inputs as the LLM ranker.
 */
export interface SkillCandidate {
  name:     string;
  summary:  string;
  entities: string[];
  tags:     string[];
}

// ── Ranker output ─────────────────────────────────────────────────────────────

/**
 * One ranker verdict: how well a given fact fits a given skill, plus a short rationale.
 *
 * `score` is a [0, 1] real. The pipeline (not the ranker) decides what counts as "strong" vs
 * "weak" vs "none" by comparing against configured thresholds — that keeps the ranker's contract
 * implementation-agnostic (a cosine-similarity ranker produces the same shape as an LLM ranker).
 *
 * `reasoning` is a one-line explanation, recorded on the {@link DreamRun} when this score is the
 * one that drove the decision. An embedding ranker is free to return `""` here — it's
 * observability sugar, not part of the routing logic.
 *
 * `factId` and `skill` echo the inputs so the pipeline can match scores back to pairs without
 * relying on positional order in the returned array (rankers may batch internally and reorder).
 */
export interface Score {
  factId:    string;
  skill:     string;
  score:     number;
  reasoning: string;
}

// ── Pipeline-side decisions (post-thresholding) ───────────────────────────────

/**
 * The pipeline's verdict for one fact, derived from its top-scoring {@link Score} and the
 * configured thresholds. Owned by the pipeline, not the ranker:
 *
 *   strong → score >= settings.strongThreshold; the fact will be merged into `skill`.
 *   weak   → score >= settings.weakThreshold but < strongThreshold. The fact itself is fine — no
 *            existing skill is a confident enough home for it *yet*. Deferred via `ignoreUntil`
 *            (see {@link RememberedFact}) rather than retired: the skill landscape can still
 *            change (a skill grows into a fit, or a new one gets minted from a cluster of
 *            similarly-homeless facts), so re-asking later may get a different answer.
 *   none   → no candidate cleared the weak threshold (or no candidates at all). Unlike `weak`,
 *            re-asking the same ranker the same question won't change — this is a durable verdict
 *            about the fact, not the skill landscape — so it retires via {@link DREAM_SKILL_NONE}.
 *
 * `skill` is present iff `decision` is `strong` or `weak` (i.e. there was a top candidate to
 * name). For `none`, `skill` is omitted. `reasoning` carries the top score's `reasoning` field
 * through to the run record.
 */
export interface RouteDecision {
  decision:  'strong' | 'weak' | 'none';
  skill?:    string;
  score?:    number;
  reasoning: string;
}

// ── Merger output ─────────────────────────────────────────────────────────────

/**
 * The result of splicing a fact into a skill's prose.
 *
 * `content` is the COMPLETE updated skill markdown, ready to hand straight to
 * `SkillManager.save()`. The pipeline does not attempt to verify "no content was deleted" — that
 * is the merger implementation's responsibility. For the LLM-backed merger, it is enforced via
 * the system prompt; a future deterministic merger would enforce it structurally.
 *
 * `contradictions` is the structured form of any `(!) Note: ...` markers the merger inserted into
 * the prose. We carry both — the markers in the markdown (for humans reading the skill) and the
 * structured list (for the {@link DreamRun} record). `location` is a short heading-or-section
 * hint; precision is not required.
 */
export interface MergeResult {
  content:        string;
  contradictions: { location: string; note: string }[];
}

// ── DreamRun record ───────────────────────────────────────────────────────────

/**
 * The summary bucket for a single `runOnce()` pass. A pass now drains the whole ranked backlog —
 * it can merge into several skills, defer, retire and quarantine facts all in one go — so the
 * outcome is a one-glance summary and the `deferred`/`retired`/`quarantined`/`mergedFactIds` counts
 * carry the detail:
 *
 *   `no-facts`  — no eligible facts to process; count fields are all zero.
 *   `no-match`  — facts were processed but none merged (all deferred/retired, or no candidate
 *                 skills at all); `primaryFact`/`routedTo` describe the oldest fact's verdict.
 *   `merged`    — at least one fact was spliced into a skill; `mergedFactIds` is non-empty and
 *                 `primaryFact`/`routedTo` describe the oldest fact. Other facts may also have been
 *                 deferred/retired/quarantined in the same pass — see the counts.
 *   `error`     — a catastrophic, setup-shaped failure ended the pass (missing service, invalid
 *                 settings); `error` carries the message. Per-fact merge failures do NOT produce
 *                 this outcome — they quarantine the culprit via {@link DREAM_SKILL_ERROR}, are
 *                 counted in `quarantined`, listed in `errors`, and the pass carries on.
 */
export type DreamRunOutcome = 'no-facts' | 'no-match' | 'merged' | 'error';

/** Per-call telemetry: which interface was invoked, how big the input was, how long it took. */
export interface JudgementCallStat {
  role:        'rank' | 'merge' | 'cluster' | 'write';
  inputSize:   number;   // facts × skills for rank; facts for merge, cluster and write
  ms:          number;
}

/**
 * One run of the dream-time pipeline, persisted to the `dream_runs` store.
 *
 * `id` / `version` satisfy the `Store<T>` constraint. The record is written exactly once, at the
 * end of a run — no streaming or partial state. Concurrent runs are prevented by a process-local
 * mutex in the service, so a record always represents a complete, serialised pass.
 */
export interface DreamRun {
  id:                  string;
  version:             string;
  startedAt:           string;
  endedAt:             string;
  outcome:             DreamRunOutcome;
  primaryFact?:        { id: string; preview: string };
  routedTo?:           { skill: string; decision: RouteDecision['decision']; score: number; reasoning: string };
  mergedFactIds:       string[];
  contradictions:      { skill: string; location: string; note: string }[];
  /** How many facts were deferred this pass: `weak`-routed facts plus `none` facts left over the
   *  enrichment budget (both via `ignoreUntil`, both reconsidered later). */
  deferred:            number;
  /** How many facts were retired terminally this pass (`none` after their enrichment look, via
   *  {@link DREAM_SKILL_NONE}). */
  retired:             number;
  /** How many facts were quarantined this pass after a durable merge failure ({@link DREAM_SKILL_ERROR}). */
  quarantined:         number;
  /** How many facts were moved to the backlog this pass ({@link DREAM_SKILL_BACKLOG}): weak for the
   *  `weakVerdictsBeforeBacklog`th time. Absent from runs recorded before the backlog existed. */
  backlogged?:         number;
  /** How many facts were retired this pass as already stated ({@link DREAM_SKILL_KNOWN}). Absent from runs
   *  recorded before that existed. */
  known?:              number;
  /** Facts returned to the backlog this pass because the skill they were filed in no longer exists. */
  orphaned?:           number;
  /** Backlogged facts given one more ranking this pass because a skill was added since the last. */
  released?:           number;
  /** What the clustering step did, when it ran this pass (see `settings.clusterAfterBacklogGrowth`). */
  clustering?: {
    /** Backlogged facts offered to the clusterer. */
    backlog:     number;
    /** Candidate skills created, each from a group of backlogged facts. */
    candidates:  string[];
    /** Existing skills a group was merged into, in one call each. */
    mergedInto:  string[];
    /** Backlogged facts filed into a candidate or an existing skill. */
    filed:       number;
    /** New groups the writer declined to make a skill of, none of their facts being skill material. Their
     *  facts stay in the backlog. */
    declined?:   string[];
    errors?:     string[];
  };
  /** How many facts were retired this pass as restatements of one already decided, or of one decided in this
   *  pass ({@link DREAM_SKILL_DUPLICATE}). Absent from runs recorded before duplicates were retired. */
  duplicates?:         number;
  /** Immediately-actionable facts left after this pass — `strong` facts that exceeded the merge
   *  budget (or per-skill cluster cap). Deferred/retired/merged/quarantined/duplicate facts are NOT counted:
   *  this is the signal a scheduler can use to decide whether to re-fire straight away. */
  unassignedRemaining: number;
  judgementCalls:      JudgementCallStat[];
  /** True if the oldest (primary) fact's verdict was reached only after a provenance-enriched
   *  re-rank (see `buildEnrichedFact` in runOnce.ts). Reflects the primary fact only — other facts
   *  in the same pass may also have been enriched. */
  enriched?:           boolean;
  /** Per-fact merge/save failures collected this pass (one pass can touch several skills, so this
   *  is a list). A single skill's failure no longer aborts the whole pass. */
  errors?:             string[];
  /** Catastrophic, setup-shaped failure that ended the pass before normal completion. */
  error?:              string;
}

// ── Inputs the pipeline owns (mirroring the cognition store shape) ────────────

/**
 * The shape of a `remembered_facts` document. Mirrored here so dream-time has a real type to work
 * with; keep in sync with the `shape` field in cognition's `defineStore('remembered_facts', …)`.
 *
 * `dreamSkill` is the "processed" marker. Its presence (regardless of value) means a previous
 * pass already routed this fact TERMINALLY — no future pass will reconsider it. The value, when
 * set to a real skill name, is what we merged into; {@link DREAM_SKILL_NONE} and
 * {@link DREAM_SKILL_ERROR}, {@link DREAM_SKILL_DUPLICATE}, {@link DREAM_SKILL_BACKLOG} and {@link DREAM_SKILL_KNOWN} are sentinels for the terminal non-routes (see below). A `weak`
 * verdict deliberately does NOT set `dreamSkill` — it is not terminal, it is deferred via
 * `ignoreUntil`.
 *
 * `ignoreUntil`, when set and in the future, excludes the fact from selection without retiring
 * it. This is the `weak` outcome's bookkeeping: the fact is sound, but no existing skill is a
 * confident-enough home for it *right now*. The skill landscape can change (a skill grows into a
 * fit, or a new one is minted from a cluster of similarly-homeless facts) — re-ranking later may
 * get a different answer, so the fact stays in the pool rather than being discarded. Separate
 * from `createdAt` so original capture provenance is never mutated.
 */
export interface RememberedFact {
  id:           string;
  version:      string;
  fact:         string;
  sessionId:    string;
  messageId:    string;
  createdAt:    string;
  dreamSkill?:  string;
  ignoreUntil?: string;
  /** How many passes have routed this fact `weak`. Counted from when the backlog was introduced, so a fact
   *  deferred before then starts at 0. */
  weakVerdicts?: number;
  /** The top candidate at the fact's latest weak verdict. Kept so that a later look at the backlog can tell
   *  a fact no skill fits (a low score everywhere) from one a skill already says in other words (a score
   *  just under the strong threshold against a skill that covers it), without ranking it again. */
  lastVerdict?:  { skill: string; score: number; reasoning: string };
  /** The skill this fact was filed in when a pass found that skill gone (deleted, or a candidate rejected)
   *  and returned the fact to the backlog. Clustering is told these names so as not to propose a rejected
   *  candidate again. */
  orphanedFrom?: string;
}

/** Sentinel `dreamSkill` value for facts the pipeline triaged and durably declined to route — the
 *  ranker found no plausible skill at all (a verdict about the fact, not the skill landscape, so
 *  re-asking later won't change it). */
export const DREAM_SKILL_NONE = '__none__';

/** Sentinel `dreamSkill` value for facts quarantined after a durable merge failure (unparseable
 *  response, truncation, the merger's own length-guard). These need human intervention — a
 *  config fix, a provider swap — not an automatic retry, so the pipeline does not re-attempt them;
 *  it marks them and moves on. Distinct from {@link DREAM_SKILL_NONE} so a `dream_runs` query can
 *  tell "the ranker declined this" apart from "the merger choked on this". */
export const DREAM_SKILL_ERROR = '__error__';

/** Sentinel `dreamSkill` value for a fact retired as a restatement: its text (see `factKey` in runOnce.ts)
 *  matches a fact that was merged, retired, or itself retired as a duplicate. No judgement call is made about
 *  it — the decision was made about its twin — which is the point: a fact captured again and again would
 *  otherwise be ranked again and again, and merged as often as a re-roll scored it strong. */
export const DREAM_SKILL_DUPLICATE = '__duplicate__';

/** Sentinel `dreamSkill` value for a fact routed `weak` `weakVerdictsBeforeBacklog` times: sound, but with
 *  no confident home among the skills that existed while it was asked. Passes stop re-ranking it, since
 *  asking the same question again only re-rolls a noisy score until one crosses the strong threshold by
 *  chance. Unlike {@link DREAM_SKILL_NONE} it is not a verdict on the fact: it is the pool a future step
 *  clusters into new skills, and releases for one more ranking when the skills change. */
export const DREAM_SKILL_BACKLOG = '__backlog__';

/** Sentinel `dreamSkill` value for a fact routed weak to a skill whose text already contains every anchor of
 *  it (see `alreadyStated` in runOnce.ts): an address, a number, a quoted identifier. The ranker scores a
 *  restatement weak because it adds nothing, which is not the same as having no home; deferring it, and
 *  then backlogging it for clustering, would only rediscover the skill that already holds it. */
export const DREAM_SKILL_KNOWN = '__known__';

// ── Settings ──────────────────────────────────────────────────────────────────

/**
 * Tunable knobs for one run. Read via `services.settings()` at the start of each `runOnce()` and
 * passed down as plain data, so the pipeline body is pure (settings in → run out) and the same
 * defaults apply on a fresh install with no stored settings.
 *
 *   strongThreshold — minimum score to trigger a merge (default 0.75).
 *   weakThreshold   — minimum score to record as a weak match (default 0.5); below this, "none".
 *                      Must be <= strongThreshold or the pipeline will reject the settings.
 *   maxClusterSize  — cap on facts merged in one pass, including the primary (default 5).
 *   blocklist       — skill names never offered to the ranker (default ["Inner voice"].
 *                     Case-sensitive exact match on `SkillDoc.name`.
 *   weakDeferralMs  — how long a `weak`-routed fact is excluded from selection before it is
 *                      reconsidered (default 36 hours, as milliseconds). Not a retry budget — there
 *                      is no cap on how many times a fact may be deferred; the field exists so a
 *                      stalled queue doesn't re-rank the same weak fact every single pass while
 *                      still giving the skill landscape time to change between looks.
 */
export interface DreamSettings {
  strongThreshold:       number;
  weakThreshold:         number;
  maxClusterSize:        number;
  blocklist:             string[];
  weakDeferralMs:        number;
  /** Cap on the total number of facts merged across all skills in one pass (default 20). The single
   *  whole-backlog rank call is already paid before this kicks in, so raising it costs only merge
   *  calls, not re-ranking. Strong facts beyond the cap are left untouched and picked up next pass. */
  maxMergesPerPass:      number;
  /** Cap on how many `none`-scoring facts get a provenance-enriched second look (one rank call each)
   *  per pass (default 10). `none` facts beyond the cap are deferred — not retired — so they are
   *  reconsidered (and enriched) in a later pass rather than re-ranked every pass. 0 disables
   *  enrichment entirely (every first-pass `none` retires immediately). */
  maxEnrichmentsPerPass: number;
  /** How many weak verdicts a fact gets before it moves to the backlog ({@link DREAM_SKILL_BACKLOG})
   *  instead of being deferred again (default 4: about six days at the default deferral). */
  weakVerdictsBeforeBacklog: number;
  /** How many facts the backlog must have gained since the last clustering before a pass clusters it
   *  again (default 30). The first clustering runs once the backlog first holds this many. */
  clusterAfterBacklogGrowth: number;
  /** The fewest backlogged facts a group needs to become a candidate skill (default 8). A group whose
   *  home is an existing skill is merged into it whatever its size. */
  minClusterSize: number;
}

export const DEFAULT_DREAM_SETTINGS: DreamSettings = {
  strongThreshold:       0.75,
  weakThreshold:         0.5,
  maxClusterSize:        5,
  blocklist:             ['Inner voice'],
  weakDeferralMs:        36 * 60 * 60 * 1000,
  maxMergesPerPass:      20,
  maxEnrichmentsPerPass: 10,
  weakVerdictsBeforeBacklog: 4,
  clusterAfterBacklogGrowth: 30,
  minClusterSize: 8,
};

/** Storage key for the persisted (partial) {@link DreamSettings} override. Shared by `runOnce`'s
 *  loader and `cognition_config`'s get/set/clear so the two can never drift onto different keys. */
export const DREAM_SETTINGS_KEY = 'dream-time';

/**
 * Cross-field validation for an EFFECTIVE (defaults-already-merged) {@link DreamSettings}. Throws
 * with a descriptive message on the first violation found. Callers decide how to surface it:
 * `runOnce`'s loader treats a violation as a setup-shaped failure worth crashing the pass on;
 * `cognition_config`'s `set` catches it and reports a tool error so a bad patch is never persisted.
 */
export function validateDreamSettings(s: DreamSettings): void {
  if (s.strongThreshold < 0 || s.strongThreshold > 1) {
    throw new Error(`strongThreshold (${s.strongThreshold}) must be within [0, 1].`);
  }
  if (s.weakThreshold < 0 || s.weakThreshold > 1) {
    throw new Error(`weakThreshold (${s.weakThreshold}) must be within [0, 1].`);
  }
  if (s.weakThreshold > s.strongThreshold) {
    throw new Error(`weakThreshold (${s.weakThreshold}) must be <= strongThreshold (${s.strongThreshold}).`);
  }
  if (!Number.isInteger(s.maxClusterSize) || s.maxClusterSize < 1) {
    throw new Error(`maxClusterSize (${s.maxClusterSize}) must be an integer >= 1.`);
  }
  if (s.weakDeferralMs < 0) {
    throw new Error(`weakDeferralMs (${s.weakDeferralMs}) must be >= 0.`);
  }
  if (!Number.isInteger(s.maxMergesPerPass) || s.maxMergesPerPass < 1) {
    throw new Error(`maxMergesPerPass (${s.maxMergesPerPass}) must be an integer >= 1.`);
  }
  if (!Number.isInteger(s.maxEnrichmentsPerPass) || s.maxEnrichmentsPerPass < 0) {
    throw new Error(`maxEnrichmentsPerPass (${s.maxEnrichmentsPerPass}) must be an integer >= 0.`);
  }
  if (!Number.isInteger(s.weakVerdictsBeforeBacklog) || s.weakVerdictsBeforeBacklog < 1) {
    throw new Error(`weakVerdictsBeforeBacklog (${s.weakVerdictsBeforeBacklog}) must be an integer >= 1.`);
  }
  if (!Number.isInteger(s.clusterAfterBacklogGrowth) || s.clusterAfterBacklogGrowth < 1) {
    throw new Error(`clusterAfterBacklogGrowth (${s.clusterAfterBacklogGrowth}) must be an integer >= 1.`);
  }
  if (!Number.isInteger(s.minClusterSize) || s.minClusterSize < 2) {
    throw new Error(`minClusterSize (${s.minClusterSize}) must be an integer >= 2.`);
  }
}
