/**
 * The dream-time pipeline: the deterministic spine of one consolidation pass.
 *
 * `runOnce` is pure procedure. Every irreducibly-judgemental step is delegated through one of two
 * narrow interfaces — {@link Ranker} for scoring (fact, skill) pairs, {@link Merger} for editing
 * prose. Everything else — fetching facts, filtering out already-processed ones, picking the
 * oldest, building the candidate set, applying the blocklist, thresholding scores into routing
 * decisions, identifying cluster-mates, looping the merger over the cluster, CAS-writing facts
 * back, assembling and persisting the {@link DreamRun} record — is here, in TypeScript, in one
 * readable function.
 *
 * The point of this layout is observability and replaceability. The pipeline can be reasoned
 * about, traced, and tested without ever calling an LLM (pass in stub Ranker/Merger). The Ranker
 * can be swapped for an embedding implementation, a small classifier, or anything else without
 * touching this file.
 *
 * `runOnce` itself is a single async function rather than a class because there is no per-call
 * state worth carrying across calls. Cross-call concerns (the process-local mutex that serialises
 * runs, the wiring of stores, the choice of Ranker/Merger implementation) live in the caller —
 * `./service.ts` when added, or the tool executor when added — not here.
 */

import type { MatbotServices, Store } from '@matatbread/matbot-plugin-api';
import type { Ranker, Merger } from './ranker.js';
import {
  type DreamRun,
  type DreamRunOutcome,
  type DreamSettings,
  type JudgementCallStat,
  type MergeResult,
  type RememberedFact,
  type RouteDecision,
  type Score,
  type SkillCandidate,
  DEFAULT_DREAM_SETTINGS,
  DREAM_SKILL_NONE,
} from './types.js';

// ── Settings I/O ──────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'dream-time';

/**
 * Load and validate the tunables. Missing values fall back to {@link DEFAULT_DREAM_SETTINGS}, so a
 * fresh install with no stored settings runs with reasonable defaults. The threshold ordering
 * (weak <= strong) is enforced here, not in the store: a malformed setting is a setup bug we want
 * to surface loudly at the start of a run, not silently paper over.
 */
async function loadSettings(services: MatbotServices): Promise<DreamSettings> {
  const stored = await services.settings().get<Partial<DreamSettings>>(SETTINGS_KEY);
  const s: DreamSettings = { ...DEFAULT_DREAM_SETTINGS, ...(stored ?? {}) };
  if (s.weakThreshold > s.strongThreshold) {
    throw new Error(
      `dream-time settings invalid: weakThreshold (${s.weakThreshold}) > strongThreshold ` +
      `(${s.strongThreshold}). Repair via services.settings().set('${SETTINGS_KEY}', …).`,
    );
  }
  if (s.maxClusterSize < 1) {
    throw new Error(`dream-time settings invalid: maxClusterSize (${s.maxClusterSize}) must be >= 1.`);
  }
  return s;
}

// ── Fact selection ────────────────────────────────────────────────────────────

/**
 * Fetch every still-unassigned fact (no `dreamSkill` field) and sort oldest-first. Ties on
 * `createdAt` are broken by `id` (lexicographic) for stable ordering across runs.
 *
 * We page through the store fully rather than relying on a single query: the store API does not
 * promise unbounded result sets in one call, and dream-time is a background pass — paging is fine.
 *
 * The `exists: false` filter on `dreamSkill` means facts with a sentinel ({@link DREAM_SKILL_NONE})
 * are NOT returned: the pipeline has already triaged them and a future pass won't reconsider.
 */
async function fetchUnassignedFacts(store: Store<RememberedFact>): Promise<RememberedFact[]> {
  const out: RememberedFact[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.query(
      cursor !== undefined
        ? { cursor }
        : {
            where: { op: 'exists', field: 'dreamSkill', value: false },
            sort:  [{ field: 'createdAt', dir: 'asc' }, { field: 'id', dir: 'asc' }],
          },
    );
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out;
}

// ── Candidate assembly ────────────────────────────────────────────────────────

/**
 * Build the {@link SkillCandidate} list from the live skill manager: every skill, minus the
 * blocklist, projected down to (name, summary, entities, tags).
 *
 * Missing metadata is a hard error: skills layer is responsible for keeping `knowledge` current on
 * write, and dream-time would not be doing useful work if it ranked against blank summaries. We
 * fail with a clear, actionable message rather than silently dropping skills (which would make
 * routing decisions inscrutable).
 */
function buildCandidates(
  services: MatbotServices,
  blocklist: readonly string[],
): SkillCandidate[] {
  const manager = services.SkillManager;
  if (manager === undefined) {
    throw new Error('dream-time requires a SkillManager service; none is registered.');
  }
  const blocked = new Set(blocklist);
  const candidates: SkillCandidate[] = [];
  const missing: string[] = [];
  for (const summary of manager.list()) {
    if (blocked.has(summary.name)) continue;
    const doc = manager.get(summary.name);
    if (doc === undefined) continue;   // raced with a delete — fine, just skip
    const k = doc.knowledge;
    if (k === undefined) {
      missing.push(doc.name);
      continue;
    }
    candidates.push({ name: doc.name, summary: k.summary, entities: k.entities, tags: k.tags });
  }
  if (missing.length > 0) {
    throw new Error(
      `dream-time requires every skill to have populated metadata, but these do not: ` +
      `${missing.join(', ')}. Run the skills metadata-population pass before invoking dream-time.`,
    );
  }
  return candidates;
}

// ── Ranking and thresholding ──────────────────────────────────────────────────

/**
 * The pipeline's routing decision for one fact: take the highest score across all candidate
 * skills, compare to thresholds, return a {@link RouteDecision}. The score's `reasoning` rides
 * along onto the decision so the {@link DreamRun} can record why.
 *
 * Tie-breaking among equal top scores is by skill name (lexicographic). This is deterministic but
 * arbitrary; in practice ties at three decimal places will be vanishingly rare and a tie at the
 * threshold boundary is itself a signal the thresholds want tuning.
 */
function decide(
  factId:   string,
  byFact:   Map<string, Score[]>,
  settings: DreamSettings,
): RouteDecision {
  const scores = byFact.get(factId) ?? [];
  if (scores.length === 0) {
    return { decision: 'none', reasoning: 'no candidates were scored for this fact' };
  }
  const sorted = [...scores].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.localeCompare(b.skill);
  });
  const top = sorted[0];
  if (top === undefined) {
    // scores was non-empty (guarded above) yet sort produced no head — impossible, but the
    // type-checker can't see that. Treat as none rather than throwing.
    return { decision: 'none', reasoning: 'no candidates were scored for this fact' };
  }
  if (top.score >= settings.strongThreshold) {
    return { decision: 'strong', skill: top.skill, score: top.score, reasoning: top.reasoning };
  }
  if (top.score >= settings.weakThreshold) {
    return { decision: 'weak',   skill: top.skill, score: top.score, reasoning: top.reasoning };
  }
  return { decision: 'none', score: top.score, reasoning: top.reasoning };
}

/** Group flat scores by fact id for O(1) per-fact lookup during decide(). */
function indexScoresByFact(scores: readonly Score[]): Map<string, Score[]> {
  const m = new Map<string, Score[]>();
  for (const s of scores) {
    const arr = m.get(s.factId);
    if (arr === undefined) m.set(s.factId, [s]);
    else arr.push(s);
  }
  return m;
}

// ── Persistence helpers ───────────────────────────────────────────────────────

/**
 * Mark a fact as processed by setting its `dreamSkill` field. Uses CAS to avoid clobbering a
 * concurrent edit (a user-visible `remembered_facts_action({action:'set'})` mid-run, say). On a
 * CAS miss we re-read and retry once; if that also fails we give up and let the caller record a
 * partial outcome — better than spinning.
 */
async function markProcessed(
  store:     Store<RememberedFact>,
  factId:    string,
  dreamSkill: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await store.get(factId);
    if (fresh === null) return;   // deleted underneath us — nothing to mark
    const next: RememberedFact = { ...fresh, dreamSkill };
    const res = await store.cas(fresh.id, fresh.version, next);
    if (res.ok) return;
  }
  throw new Error(`dream-time could not CAS-update fact ${factId} after retry`);
}

// ── The pipeline ──────────────────────────────────────────────────────────────

/**
 * One consolidation pass. Returns the {@link DreamRun} record without persisting it — the caller
 * (the tool executor) is responsible for `dreamRuns.set(run.id, run)`, so a failure to persist the
 * record does not double-charge a successful merge. The record is fully assembled in memory before
 * any store write happens.
 *
 * The function does not throw on judgement-call failures or per-fact CAS misses: those are caught
 * locally, recorded as an `error` outcome on the run, and the run record is still returned. It
 * does throw on setup-shaped problems (missing services, invalid settings, missing metadata) —
 * those are bugs the caller should surface, not data points to record.
 */
export async function runOnce(
  services: MatbotServices,
  ranker:   Ranker,
  merger:   Merger,
  signal:   AbortSignal,
): Promise<DreamRun> {
  const startedAt = new Date().toISOString();
  const runId     = cryptoRandomId();
  const calls: JudgementCallStat[] = [];

  // Setup-shaped failures throw; everything past here is caught into the run record.
  const settings = await loadSettings(services);
  const manager  = services.SkillManager;
  if (manager === undefined) {
    throw new Error('dream-time requires a SkillManager service; none is registered.');
  }
  const facts      = services.createStore<RememberedFact>('remembered_facts');
  const candidates = buildCandidates(services, settings.blocklist);

  // Helpers that finalise a run record. All exits go through one of these.
  const finish = (
    outcome:             DreamRunOutcome,
    unassignedRemaining: number,
    extras:              Partial<DreamRun> = {},
  ): DreamRun => ({
    id:             runId,
    version:        '',          // store mints on write
    startedAt,
    endedAt:        new Date().toISOString(),
    outcome,
    mergedFactIds:  [],
    contradictions: [],
    unassignedRemaining,
    judgementCalls: calls,
    ...extras,
  });

  try {
    const unassigned = await fetchUnassignedFacts(facts);
    if (unassigned.length === 0) return finish('no-facts', 0);
    if (candidates.length === 0) {
      // No skills to route into — every fact will route 'none'. Don't burn a rank call.
      const primary = unassigned[0];
      if (primary === undefined) return finish('no-facts', 0);   // unreachable: length>0 above
      return finish('no-match', unassigned.length, {
        primaryFact: { id: primary.id, preview: preview(primary.fact) },
        routedTo:    { skill: '', decision: 'none', score: 0, reasoning: 'no candidate skills available' },
      });
    }

    // ONE rank call, over every (fact, skill) pair. The ranker is free to batch internally.
    const rankStart = Date.now();
    const scores    = await ranker.rank(unassigned, candidates, signal);
    calls.push({ role: 'rank', inputSize: unassigned.length * candidates.length, ms: Date.now() - rankStart });
    const byFact = indexScoresByFact(scores);

    const primary = unassigned[0];
    if (primary === undefined) return finish('no-facts', 0);   // unreachable: length>0 above
    const primaryDecision = decide(primary.id, byFact, settings);

    // Weak / none: record and exit. No merge, no fact-marking for weak (the prose spec leaves
    // weak facts in the store for a future pass); for 'none' we set the sentinel so we don't
    // reconsider the same fact every run.
    if (primaryDecision.decision !== 'strong') {
      if (primaryDecision.decision === 'none') {
        await markProcessed(facts, primary.id, DREAM_SKILL_NONE);
      }
      return finish('no-match', unassigned.length - (primaryDecision.decision === 'none' ? 1 : 0), {
        primaryFact: { id: primary.id, preview: preview(primary.fact) },
        routedTo:    {
          skill:     primaryDecision.skill ?? '',
          decision:  primaryDecision.decision,
          score:     primaryDecision.score ?? 0,
          reasoning: primaryDecision.reasoning,
        },
      });
    }

    // Strong: identify cluster-mates — other unassigned facts whose top-scoring skill is the
    // SAME as the primary's chosen skill, also above strongThreshold. Cap at maxClusterSize total.
    const chosenSkill = primaryDecision.skill as string;   // strong implies skill present
    const clusterMates: RememberedFact[] = [];
    for (const f of unassigned.slice(1)) {
      if (clusterMates.length + 1 >= settings.maxClusterSize) break;   // +1 for the primary
      const d = decide(f.id, byFact, settings);
      if (d.decision === 'strong' && d.skill === chosenSkill) clusterMates.push(f);
    }
    const cluster = [primary, ...clusterMates];

    // Load the chosen skill's full prose and merge each cluster member in turn. Each merge sees
    // the prior merges' output, so contradiction detection has the full evolving picture.
    const doc = manager.get(chosenSkill);
    if (doc === undefined) {
      // Raced with a delete between buildCandidates() and now. Report and exit cleanly.
      return finish('error', unassigned.length, {
        primaryFact: { id: primary.id, preview: preview(primary.fact) },
        routedTo:    { skill: chosenSkill, decision: 'strong', score: primaryDecision.score ?? 0, reasoning: primaryDecision.reasoning },
        error:       `skill "${chosenSkill}" disappeared mid-run`,
      });
    }

    let content = doc.content;
    const allContradictions: DreamRun['contradictions'] = [];
    const mergedFactIds: string[] = [];
    for (const f of cluster) {
      const mergeStart = Date.now();
      let result: MergeResult;
      try {
        result = await merger.merge(chosenSkill, content, f, signal);
      } catch (e) {
        calls.push({ role: 'merge', inputSize: 1, ms: Date.now() - mergeStart });
        return finish('error', unassigned.length - mergedFactIds.length, {
          primaryFact: { id: primary.id, preview: preview(primary.fact) },
          routedTo:    { skill: chosenSkill, decision: 'strong', score: primaryDecision.score ?? 0, reasoning: primaryDecision.reasoning },
          mergedFactIds,
          contradictions: allContradictions,
          error: `merge failed on fact ${f.id}: ${(e as Error).message ?? String(e)}`,
        });
      }
      calls.push({ role: 'merge', inputSize: 1, ms: Date.now() - mergeStart });
      content = result.content;
      for (const c of result.contradictions) {
        allContradictions.push({ skill: chosenSkill, location: c.location, note: c.note });
      }
      mergedFactIds.push(f.id);
    }

    // All merges succeeded — persist the new skill content, then mark each fact processed.
    // Skill save first so a CAS failure on a fact doesn't strand an un-saved merge.
    await manager.save(chosenSkill, content);
    for (const id of mergedFactIds) await markProcessed(facts, id, chosenSkill);

    return finish('merged', unassigned.length - mergedFactIds.length, {
      primaryFact: { id: primary.id, preview: preview(primary.fact) },
      routedTo:    { skill: chosenSkill, decision: 'strong', score: primaryDecision.score ?? 0, reasoning: primaryDecision.reasoning },
      mergedFactIds,
      contradictions: allContradictions,
    });
  } catch (e) {
    // Catch-all for anything we didn't anticipate. The run is recorded; the tool surfaces it.
    return finish('error', -1, { error: (e as Error).message ?? String(e) });
  }
}

// ── Tiny utilities ────────────────────────────────────────────────────────────

const PREVIEW_LEN = 80;
function preview(s: string): string {
  return s.length <= PREVIEW_LEN ? s : s.slice(0, PREVIEW_LEN - 1) + '…';
}

/** Node 16+ exposes crypto.randomUUID globally; fall back to a Math.random id for older runtimes. */
function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `dream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
