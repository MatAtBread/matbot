/**
 * The dream-time pipeline: the deterministic spine of one consolidation pass.
 *
 * `runOnce` is pure procedure. Every irreducibly-judgemental step is delegated through one of two
 * narrow interfaces — {@link Ranker} for scoring (fact, skill) pairs, {@link Merger} for editing
 * prose. Everything else — fetching facts, filtering out already-processed ones, building the
 * candidate set, applying the blocklist, thresholding scores into routing decisions, grouping the
 * strong facts by chosen skill, looping the merger over each skill's cluster, CAS-writing facts
 * back, assembling and persisting the {@link DreamRun} record — is here, in TypeScript, in one
 * readable function.
 *
 * One pass ranks the WHOLE backlog in a single call and then spends that one ranking on every fact:
 * it drains the strong facts (grouped by skill, up to a per-pass merge budget), defers the weak
 * ones, and retires the dead `none` ones — all in the same pass. The single most expensive thing —
 * the rank call — is paid once whether one fact moves or fifty, so acting on only the oldest (the
 * original design, born of an in-LLM implementation that blew context across passes) left almost
 * all of that paid-for work on the floor. The merge budget bounds how much prose-editing one pass
 * does; everything above it waits for the next pass.
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

import type { MatbotMachine, Message, MessageContent, Store } from '@matatbread/matbot-plugin-api';
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
  DREAM_SETTINGS_KEY,
  DREAM_SKILL_ERROR,
  DREAM_SKILL_NONE,
  validateDreamSettings,
} from './types.js';

// ── Settings I/O ──────────────────────────────────────────────────────────────

/**
 * Load and validate the tunables. Missing values fall back to {@link DEFAULT_DREAM_SETTINGS}, so a
 * fresh install with no stored settings runs with reasonable defaults. Validation is shared with
 * `cognition_config`'s `set` (see {@link validateDreamSettings}) so the two can never disagree on
 * what counts as valid — this call is the last-resort safety net for settings written outside that
 * tool (or before it existed), surfaced loudly at the start of a run rather than papered over.
 */
async function loadSettings(services: MatbotMachine): Promise<DreamSettings> {
  const stored = await services.settings().get<Partial<DreamSettings>>(DREAM_SETTINGS_KEY);
  const s: DreamSettings = { ...DEFAULT_DREAM_SETTINGS, ...(stored ?? {}) };
  try {
    validateDreamSettings(s);
  } catch (e) {
    throw new Error(
      `dream-time settings invalid: ${(e as Error).message} Repair via the cognition_config tool ` +
      `(action "set"), or directly: services.settings().set('${DREAM_SETTINGS_KEY}', …).`,
    );
  }
  return s;
}

// ── Fact selection ────────────────────────────────────────────────────────────

/**
 * Fetch every still-eligible fact (no `dreamSkill` field, and not currently deferred past
 * `ignoreUntil`) and sort oldest-first. Ties on `createdAt` are broken by `id` (lexicographic)
 * for stable ordering across runs.
 *
 * We page through the store fully rather than relying on a single query: the store API does not
 * promise unbounded result sets in one call, and dream-time is a background pass — paging is fine.
 *
 * The `exists: false` filter on `dreamSkill` means facts with a terminal sentinel
 * ({@link DREAM_SKILL_NONE} or {@link DREAM_SKILL_ERROR}) are NOT returned: the pipeline has
 * already triaged them and no future pass will reconsider them. The `ignoreUntil` clause excludes
 * facts the pipeline routed `weak` and deferred — they are NOT terminal (no `dreamSkill` is set),
 * but are skipped until their deferral lapses, so a `weak` fact does not get re-ranked (and
 * re-block the queue) on every single pass.
 */
async function fetchUnassignedFacts(store: Store<RememberedFact>, nowIso: string): Promise<RememberedFact[]> {
  const out: RememberedFact[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.query(
      cursor !== undefined
        ? { cursor }
        : {
            where: {
              op: 'and',
              clauses: [
                { op: 'exists', field: 'dreamSkill', value: false },
                {
                  op: 'or',
                  clauses: [
                    { op: 'exists', field: 'ignoreUntil', value: false },
                    { op: 'lte',    field: 'ignoreUntil', value: nowIso },
                  ],
                },
              ],
            },
            sort: [{ field: 'createdAt', dir: 'asc' }, { field: 'id', dir: 'asc' }],
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
  services: MatbotMachine,
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
 * Patch a fact's `dreamSkill` and/or `ignoreUntil` fields. Uses CAS to avoid clobbering a
 * concurrent edit (a user-visible `remembered_facts_action({action:'set'})` mid-run, say). On a
 * CAS miss we re-read and retry once; if that also fails we give up and let the caller record a
 * partial outcome — better than spinning.
 *
 * One shared helper for every routing disposition: `{ dreamSkill: <skill> }` (merged),
 * `{ dreamSkill: DREAM_SKILL_NONE }` / `{ dreamSkill: DREAM_SKILL_ERROR }` (terminal retirement),
 * or `{ ignoreUntil }` (a `weak` deferral, leaving `dreamSkill` untouched — not terminal).
 */
async function patchFact(
  store:  Store<RememberedFact>,
  factId: string,
  patch:  Partial<Pick<RememberedFact, 'dreamSkill' | 'ignoreUntil'>>,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await store.get(factId);
    if (fresh === null) return;   // deleted underneath us — nothing to patch
    const next: RememberedFact = { ...fresh, ...patch };
    const res = await store.cas(fresh.id, fresh.version, next);
    if (res.ok) return;
  }
  throw new Error(`dream-time could not CAS-update fact ${factId} after retry`);
}

// ── Provenance enrichment (the 'none' rescue path) ────────────────────────────

/** How many messages of leading context to pull when a fact's first-pass score is 'none'. A bare
 *  atomic fact (e.g. "the user has a history of fainting") can under-score in isolation but route
 *  cleanly once the conversation that produced it disambiguates who or what it refers to. */
const ENRICHMENT_CONTEXT_MESSAGES = 3;

function isTextBlock(c: MessageContent): c is MessageContent & { type: 'text'; text: string } {
  return c.type === 'text';
}

/** Flatten a message's text blocks into one string; non-text content (tool calls, markers,
 *  images, …) is skipped — it is noise for the purpose of disambiguating a fact. */
function textOf(m: Message): string {
  return m.content.filter(isTextBlock).map(c => c.text).join(' ');
}

/**
 * Build an enriched fact string by prepending up to {@link ENRICHMENT_CONTEXT_MESSAGES} messages
 * of conversation immediately preceding the fact's origin message. Returns `undefined` when no
 * enrichment is possible — no sessions service, the session or message no longer exists (e.g. the
 * session was since compacted), or there is no text content to add — so the caller falls back to
 * the plain, un-enriched verdict. Read-only: never touches the session.
 */
async function buildEnrichedFact(
  services: MatbotMachine,
  fact:     RememberedFact,
): Promise<string | undefined> {
  try {
    const session = await services.sessions?.get(fact.sessionId);
    if (!session) return undefined;
    const idx = session.messages.findIndex(m => m.id === fact.messageId);
    if (idx <= 0) return undefined;   // not found, or it's the first message (nothing precedes it)

    const context = session.messages
      .slice(Math.max(0, idx - ENRICHMENT_CONTEXT_MESSAGES), idx)
      .map(textOf)
      .filter(t => t.length > 0)
      .join('\n');
    if (context.length === 0) return undefined;

    return `${fact.fact}\n\n[Context from the surrounding conversation, for disambiguation only:]\n${context}`;
  } catch (ex) {
    return undefined;
  }
}

// ── The pipeline ──────────────────────────────────────────────────────────────

/**
 * One consolidation pass. An async generator: it YIELDS coarse {@link DreamProgress} events as the
 * pass advances (a backlog drains as many sequential LLM calls — one rank, then a merge per fact —
 * so a pass is a long, otherwise-silent wait) and RETURNS the {@link DreamRun} record without
 * persisting it. The caller (the tool executor) drains the progress, then owns `dreamRuns.set(run.id,
 * run)`, so a failure to persist the record does not double-charge a successful merge. The record is
 * fully assembled in memory before any store write happens.
 *
 * The function does not throw on judgement-call failures or per-fact CAS misses: those are caught
 * locally, recorded as an `error` outcome on the run, and the run record is still returned. It
 * does throw on setup-shaped problems (missing services, invalid settings, missing metadata) —
 * those are bugs the caller should surface, not data points to record.
 */
export interface DreamProgress { pct: number; message: string }

// Progress is one linear bar over the per-fact LLM calls (enrichment re-ranks + merges — the slow
// body, "the run of N"): each is worth (100 − FRONT − TAIL)/N. FRONT and TAIL reserve the two batched
// costs that bracket that body and can't animate per-fact — the single up-front rank call (one LLM
// call over ALL facts) and the final save/persist.
const PROGRESS_RANK_FRONT = 10;
const PROGRESS_TAIL       = 5;

export async function* runOnce(
  services: MatbotMachine,
  ranker:   Ranker,
  merger:   Merger,
  signal:   AbortSignal,
): AsyncGenerator<DreamProgress, DreamRun, void> {
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
    deferred:       0,
    retired:        0,
    quarantined:    0,
    unassignedRemaining,
    judgementCalls: calls,
    ...extras,
  });

  try {
    const unassigned = await fetchUnassignedFacts(facts, startedAt);
    if (unassigned.length === 0) return finish('no-facts', 0);
    if (candidates.length === 0) {
      // No skills to route into at all — the purest case of "the skill landscape isn't ready",
      // not a verdict on the fact. Don't burn a rank call; don't mark anything either — this
      // branch costs one cheap query per pass and no LLM call, so the fact naturally stays
      // eligible for whenever a skill appears, with no deferral bookkeeping needed.
      const primary = unassigned[0];
      if (primary === undefined) return finish('no-facts', 0);   // unreachable: length>0 above
      return finish('no-match', unassigned.length, {
        primaryFact: { id: primary.id, preview: preview(primary.fact) },
        routedTo:    { skill: '', decision: 'weak', score: 0, reasoning: 'no candidate skills are configured at all' },
      });
    }

    const oldest = unassigned[0];
    if (oldest === undefined) return finish('no-facts', 0);   // unreachable: length>0 above

    yield { pct: 0, message: `Ranking ${unassigned.length} fact(s) against ${candidates.length} skill(s)…` };

    // ── ONE rank call over the WHOLE backlog (fact × skill). Its scores drive every fact's
    //    disposition below — the expensive call is paid once and spent on all of them, not just the
    //    oldest. The ranker is free to batch internally. ──
    const rankStart = Date.now();
    const scores    = await ranker.rank(unassigned, candidates, signal);
    calls.push({ role: 'rank', inputSize: unassigned.length * candidates.length, ms: Date.now() - rankStart });
    const byFact = indexScoresByFact(scores);

    // Classify every fact from that single rank. `unassigned` is oldest-first, so each bucket and
    // the per-skill groups below inherit that order (oldest facts processed first under any cap).
    const strong: { fact: RememberedFact; decision: RouteDecision }[] = [];
    const weak:   RememberedFact[] = [];
    const none:   RememberedFact[] = [];
    let oldestDecision: RouteDecision = { decision: 'none', reasoning: '' };
    for (const f of unassigned) {
      const d = decide(f.id, byFact, settings);
      if (f.id === oldest.id) oldestDecision = d;
      if      (d.decision === 'strong') strong.push({ fact: f, decision: d });
      else if (d.decision === 'weak')   weak.push(f);
      else                              none.push(f);
    }
    // One linear bar over the per-fact LLM calls that follow — the enrichment re-ranks plus the
    // merges. `perFactTotal` is the upper bound (every enrichable `none` could route strong and then
    // merge, capped by the merge budget), so the bar never overshoots and the tool's terminal 100%
    // covers any shortfall. FRONT is already spent on the rank above; TAIL is reserved for persist.
    const enrichDenom  = Math.min(none.length, settings.maxEnrichmentsPerPass);
    const perFactTotal = enrichDenom + Math.min(strong.length + enrichDenom, settings.maxMergesPerPass);
    let   perFactDone  = 0;
    const bar = (): number => Math.min(
      100 - PROGRESS_TAIL,
      PROGRESS_RANK_FRONT + Math.round((100 - PROGRESS_RANK_FRONT - PROGRESS_TAIL) * perFactDone / Math.max(1, perFactTotal)),
    );
    yield { pct: PROGRESS_RANK_FRONT, message: `${strong.length} to merge · ${weak.length} deferred · ${none.length} to review` };

    // ── Enrichment phase: rescue `none` facts with provenance context, oldest-first, bounded by
    //    maxEnrichmentsPerPass. A bare atomic fact can under-score in isolation but route cleanly
    //    once the conversation that produced it disambiguates it (e.g. "the user has a history of
    //    fainting" scores low alone, but belongs in a user-profile skill once the preceding messages
    //    show it was said amid dentist-visit anxiety). Exactly one re-rank per fact, never a loop.
    //    A `none` fact we can't enrich (no session/context) is terminal → retire. A `none` fact over
    //    the enrichment budget is deferred (not retired) so a future pass enriches it rather than
    //    re-ranking it every pass. ──
    const enrichedIds   = new Set<string>();
    const stillNone:    RememberedFact[] = [];
    const deferredNone: RememberedFact[] = [];
    let enrichBudget = settings.maxEnrichmentsPerPass;
    for (const f of none) {
      if (enrichBudget <= 0) { deferredNone.push(f); continue; }
      const enrichedText = await buildEnrichedFact(services, f);
      if (enrichedText === undefined) { stillNone.push(f); continue; }
      enrichBudget--;
      enrichedIds.add(f.id);
      perFactDone++;
      yield { pct: bar(), message: 'Re-checking an unmatched fact…' };
      const rerankStart    = Date.now();
      const enrichedScores = await ranker.rank([{ ...f, fact: enrichedText }], candidates, signal);
      calls.push({ role: 'rank', inputSize: candidates.length, ms: Date.now() - rerankStart });
      const d = decide(f.id, indexScoresByFact(enrichedScores), settings);
      if (f.id === oldest.id) oldestDecision = d;
      if      (d.decision === 'strong') strong.push({ fact: f, decision: d });
      else if (d.decision === 'weak')   weak.push(f);
      else                              stillNone.push(f);
    }

    // ── Cheap dispositions (no skill writes, no judgement calls): defer the weak + over-budget
    //    `none` facts, retire the terminal `none` facts. A CAS miss here means the fact was edited
    //    underneath us — harmless, the next pass reconsiders it — so we skip and carry on rather
    //    than abort the whole pass. ──
    const ignoreUntil = new Date(Date.parse(startedAt) + settings.weakDeferralMs).toISOString();
    let deferred = 0, retired = 0;
    for (const f of [...weak, ...deferredNone]) {
      try { await patchFact(facts, f.id, { ignoreUntil }); deferred++; } catch { /* raced edit */ }
    }
    for (const f of stillNone) {
      try { await patchFact(facts, f.id, { dreamSkill: DREAM_SKILL_NONE }); retired++; } catch { /* raced edit */ }
    }

    // ── Merge phase: group strong facts by their chosen skill and drain up to maxMergesPerPass
    //    total (per-skill cluster still capped at maxClusterSize). Insertion order = oldest-first,
    //    so under the budget the oldest skills/facts win. Each skill's merges run in sequence so
    //    contradiction detection sees the full evolving prose; different skills are independent. ──
    const bySkill = new Map<string, RememberedFact[]>();
    for (const s of strong) {
      const skill = s.decision.skill as string;   // strong implies skill present
      const arr = bySkill.get(skill);
      if (arr === undefined) bySkill.set(skill, [s.fact]);
      else arr.push(s.fact);
    }

    const mergedFactIds: string[] = [];
    const allContradictions: DreamRun['contradictions'] = [];
    const mergeErrors: string[] = [];
    let quarantined = 0;
    let mergeBudget = settings.maxMergesPerPass;

    for (const [skill, members] of bySkill) {
      if (mergeBudget <= 0) break;
      const doc = manager.get(skill);
      if (doc === undefined) continue;   // raced a delete between buildCandidates() and now — leave its facts for a future pass

      const cluster = members.slice(0, Math.min(settings.maxClusterSize, mergeBudget));
      let content = doc.content;
      const skillMergedIds: string[] = [];
      for (const f of cluster) {
        perFactDone++;
        yield { pct: bar(), message: `Merging into "${skill}"…` };
        const mergeStart = Date.now();
        try {
          const result: MergeResult = await merger.merge(skill, content, f, signal);
          calls.push({ role: 'merge', inputSize: 1, ms: Date.now() - mergeStart });
          content = result.content;
          for (const c of result.contradictions) allContradictions.push({ skill, location: c.location, note: c.note });
          skillMergedIds.push(f.id);
        } catch (e) {
          calls.push({ role: 'merge', inputSize: 1, ms: Date.now() - mergeStart });
          // Durable failure on THIS fact (unparseable response, truncation, length-guard) — a
          // property of this (fact, skill, provider) combination, not a transient blip. Quarantine
          // the culprit so it stops blocking the queue (needs a config fix, not an auto-retry),
          // stop this skill's cluster, but commit the merges that already succeeded (below) and
          // move on to the next skill rather than aborting the whole pass.
          try { await patchFact(facts, f.id, { dreamSkill: DREAM_SKILL_ERROR }); } catch { /* raced edit */ }
          quarantined++;
          mergeErrors.push(`merge failed on fact ${f.id} (skill "${skill}"): ${(e as Error).message ?? String(e)}`);
          break;
        }
      }
      if (skillMergedIds.length === 0) continue;
      try {
        // Skill save first so a CAS failure on a fact doesn't strand an un-saved merge.
        await manager.save(skill, content);
        for (const id of skillMergedIds) {
          try { await patchFact(facts, id, { dreamSkill: skill }); } catch { /* raced edit; fact stays eligible */ }
          mergedFactIds.push(id);
        }
        mergeBudget -= skillMergedIds.length;
      } catch (e) {
        // The skill save itself failed — none of this cluster's facts are marked, so they stay
        // eligible for a future pass. Record and continue with the remaining skills.
        mergeErrors.push(`saving skill "${skill}" failed: ${(e as Error).message ?? String(e)}`);
      }
    }

    const merged    = mergedFactIds.length;
    const remaining = unassigned.length - merged - deferred - retired - quarantined;   // over-budget strong, eligible next pass
    const outcome: DreamRunOutcome = merged > 0 ? 'merged' : 'no-match';

    return finish(outcome, remaining, {
      primaryFact: { id: oldest.id, preview: preview(oldest.fact) },
      routedTo: {
        skill:     oldestDecision.skill ?? '',
        decision:  oldestDecision.decision,
        score:     oldestDecision.score ?? 0,
        reasoning: oldestDecision.reasoning,
      },
      mergedFactIds,
      contradictions: allContradictions,
      deferred,
      retired,
      quarantined,
      ...(enrichedIds.has(oldest.id) ? { enriched: true } : {}),
      ...(mergeErrors.length > 0 ? { errors: mergeErrors } : {}),
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
