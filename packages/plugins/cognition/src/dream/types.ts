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
 *   weak   → score >= settings.weakThreshold but < strongThreshold; recorded, no merge.
 *   none   → no candidate cleared the weak threshold (or no candidates at all).
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
 * The outcome bucket for a single `runOnce()` pass. Determines which other fields on a
 * {@link DreamRun} carry meaningful values:
 *
 *   `no-facts`  — no unassigned facts to process; no other fields meaningful.
 *   `no-match`  — a fact was picked but routed `weak` or `none`; `primaryFact` and `routedTo`
 *                 are set, `mergedFactIds` is empty.
 *   `merged`    — the happy path: `primaryFact`, `routedTo` (with `decision: 'strong'`), and a
 *                 non-empty `mergedFactIds` are all set.
 *   `error`     — a pipeline step or a ranker/merger call threw; `error` carries the message.
 *                 No skill writes happen on this path, but earlier fields may be partially set
 *                 depending on how far the run got before failing.
 */
export type DreamRunOutcome = 'no-facts' | 'no-match' | 'merged' | 'error';

/** Per-call telemetry: which interface was invoked, how big the input was, how long it took. */
export interface JudgementCallStat {
  role:        'rank' | 'merge';
  inputSize:   number;   // facts × skills for rank; 1 for merge
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
  unassignedRemaining: number;
  judgementCalls:      JudgementCallStat[];
  error?:              string;
}

// ── Inputs the pipeline owns (mirroring the cognition store shape) ────────────

/**
 * The shape of a `remembered_facts` document. Mirrored here so dream-time has a real type to work
 * with; keep in sync with the `shape` field in cognition's `defineStore('remembered_facts', …)`.
 *
 * `dreamSkill` is the "processed" marker. Its presence (regardless of value) means a previous
 * pass already routed this fact. The value, when set, is the skill name we merged into;
 * {@link DREAM_SKILL_NONE} is reserved for facts the pipeline considered but declined to route,
 * so a single field encodes both "considered" and "where it went" — a future pass won't waste a
 * judgement call reconsidering a fact already triaged.
 */
export interface RememberedFact {
  id:          string;
  version:     string;
  fact:        string;
  sessionId:   string;
  messageId:   string;
  createdAt:   string;
  dreamSkill?: string;
}

/** Sentinel `dreamSkill` value for facts the pipeline triaged and declined to route. */
export const DREAM_SKILL_NONE = '__none__';

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
 */
export interface DreamSettings {
  strongThreshold: number;
  weakThreshold:   number;
  maxClusterSize:  number;
  blocklist:       string[];
}

export const DEFAULT_DREAM_SETTINGS: DreamSettings = {
  strongThreshold: 0.75,
  weakThreshold:   0.5,
  maxClusterSize:  5,
  blocklist:       ['Inner voice'],
};
