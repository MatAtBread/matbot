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
 * state worth carrying across calls. Cross-call concerns (the lease that serialises
 * runs, the wiring of stores, the choice of Ranker/Merger implementation) live in the caller —
 * `./service.ts` when added, or the tool executor when added — not here.
 */

import type { MatbotMachine, Message, MessageContent, Store, Filter } from '@matatbread/matbot-plugin-api';
import type { SkillManager } from '@matatbread/matbot-skills';
import type { Ranker, Merger, Clusterer, SkillWriter, FactGroup } from './ranker.js';
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
  DREAM_SKILL_BACKLOG,
  DREAM_SKILL_DUPLICATE,
  DREAM_SKILL_ERROR,
  DREAM_SKILL_KNOWN,
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

// ── Duplicates ────────────────────────────────────────────────────────────────

/**
 * What two facts must share to be the same fact: case, Unicode form, runs of whitespace and trailing
 * punctuation, and nothing else. A duplicate is retired unread, so this errs towards keeping two: "is at
 * 192.168.0.20" and "has IP address 192.168.0.20" stay two facts and are each ranked. Exact restatement is
 * what a recurring capture produces — one job's prompt, remembered every ten minutes, put the same three
 * sentences into the store over a thousand times — and each copy cost a rank every 36 hours for ever, and a
 * whole-skill merge whenever a re-roll scored it strong.
 */
export function factKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s.!;:,]+$/u, '');
}

/**
 * The keys of every fact a pass has already decided: merged, retired as `none`, moved to the backlog, or
 * itself a duplicate of one of those. A copy of a backlogged fact is a duplicate too: the backlog holds the
 * text once, for whatever clusters it. A quarantined fact ({@link DREAM_SKILL_ERROR}) decided nothing about its text — its merge
 * failed — so a later copy of it is ranked rather than retired.
 */
function decidedKeys(filed: readonly RememberedFact[]): Set<string> {
  const keys = new Set<string>();
  for (const f of filed) if (f.dreamSkill !== undefined && f.dreamSkill !== DREAM_SKILL_ERROR) keys.add(factKey(f.fact));
  return keys;
}

/** Every fact matching `where`, paged through to the end, oldest first. */
async function fetchAll(store: Store<RememberedFact>, where: Filter): Promise<RememberedFact[]> {
  const out: RememberedFact[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.query(cursor !== undefined ? { cursor }
      : { where, sort: [{ field: 'createdAt', dir: 'asc' }, { field: 'id', dir: 'asc' }] });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return out;
}

const SENTINELS: ReadonlySet<string> = new Set([
  DREAM_SKILL_NONE, DREAM_SKILL_ERROR, DREAM_SKILL_DUPLICATE, DREAM_SKILL_BACKLOG, DREAM_SKILL_KNOWN,
]);

/**
 * The parts of a fact a paraphrase does not change, and that do not recur in a skill by coincidence:
 * URLs, email addresses, ids (a UUID, a hex id with letters and digits) and numbers with separators five
 * characters or longer (an address, a date, a version, a time). Not a bare integer: a year, a "191" or a
 * "000" is in any long skill, and matched a pension fact and a garden sensor to the wrong one. Not a quoted
 * name either: a skill about tools names `tool_search` throughout, so a new finding about it read as known.
 */
export function anchorsOf(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)`]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) found.add(m[0]);
  for (const m of text.matchAll(/\b(?=[0-9a-f-]*\d)(?=[0-9a-f-]*[a-f])[0-9a-f]{8}(?:-[0-9a-f]{4,12})*\b/gi)) found.add(m[0]);
  for (const m of text.matchAll(/\d+(?:[.:/-]\d+)+/g)) if (m[0].length >= 5) found.add(m[0]);
  const all = [...found].map(a => a.toLowerCase().replace(/[.,;:!?]+$/, '')).filter(a => a !== '');
  return all.filter(a => !all.some(b => b !== a && b.includes(a)));   // a number inside an id is the id's
}

/**
 * Whether a fact routed weak to a skill is already in it: it has anchors, and every one appears in the
 * skill's text. Asked only of a weak verdict — a fact the ranker scored strong is merged, so one that adds
 * something to a known address is the merger's to place — and a fact with no anchors is never "known".
 */
export function alreadyStated(fact: string, skillContent: string): boolean {
  const anchors = anchorsOf(fact);
  if (anchors.length === 0) return false;
  const haystack = skillContent.toLowerCase();
  return anchors.every(a => haystack.includes(a));
}

// ── Candidate assembly ────────────────────────────────────────────────────────

/**
 * Build the {@link SkillCandidate} list from the live skill manager: every skill, minus the
 * blocklist, projected down to (name, summary, entities, tags).
 *
 * A skill with no metadata yet is left out of this pass, with a warning naming it. Ranking against a
 * blank summary routes nothing usefully, and failing the pass instead (as this did) made every pass fail
 * from a skill's creation until its analysis landed, which is detached and may take a while; and a skill
 * created hidden is never analysed at all. It is offered again once it has metadata.
 */
async function buildCandidates(
  services: MatbotMachine,
  blocklist: readonly string[],
): Promise<SkillCandidate[]> {
  const manager = services.SkillManager;
  if (manager === undefined) {
    throw new Error('dream-time requires a SkillManager service; none is registered.');
  }
  const blocked = new Set(blocklist);
  const candidates: SkillCandidate[] = [];
  const missing: string[] = [];
  for (const doc of await manager.all()) {
    if (blocked.has(doc.name)) continue;
    const k = doc.knowledge;
    if (k === undefined) {
      missing.push(doc.name);
      continue;
    }
    candidates.push({ name: doc.name, summary: k.summary, entities: k.entities, tags: k.tags });
  }
  if (missing.length > 0) {
    console.warn(`[dream] skill(s) with no metadata yet, not offered to the ranker this pass: ${missing.join(', ')}.`);
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
 *
 * A patch that depends on what the fact holds (a weak verdict counts the ones before it) is a function
 * of the fresh read, so a retry recomputes it. Returns the patch that landed, `undefined` when the fact
 * was deleted underneath us.
 */
type FactPatch = Partial<Pick<RememberedFact, 'dreamSkill' | 'ignoreUntil' | 'weakVerdicts' | 'lastVerdict' | 'orphanedFrom'>>;
async function patchFact(
  store:  Store<RememberedFact>,
  factId: string,
  patch:  FactPatch | ((fresh: RememberedFact) => FactPatch),
): Promise<FactPatch | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await store.get(factId);
    if (fresh === null) return undefined;   // deleted underneath us — nothing to patch
    const applied = typeof patch === 'function' ? patch(fresh) : patch;
    const next: RememberedFact = { ...fresh, ...applied };
    const res = await store.cas(fresh.id, fresh.version, next);
    if (res.ok) return applied;
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

/** What {@link runOnce} prepares once and the stages of a pass share. */
interface PassContext {
  services:   MatbotMachine;
  settings:   DreamSettings;
  manager:    SkillManager;
  facts:      Store<RememberedFact>;
  candidates: SkillCandidate[];
  /** Every fact with a `dreamSkill`, read once at the start of the pass. */
  filed:      RememberedFact[];
  calls:      JudgementCallStat[];
  startedAt:  string;
  runId:      string;
}

export async function* runOnce(
  services: MatbotMachine,
  ranker:   Ranker,
  merger:   Merger,
  signal:   AbortSignal,
  grouping?: { clusterer: Clusterer; writer: SkillWriter },
): AsyncGenerator<DreamProgress, DreamRun, void> {
  // Setup-shaped failures throw; everything past here is caught into the run record.
  const settings = await loadSettings(services);
  const manager  = services.SkillManager;
  if (manager === undefined) {
    throw new Error('dream-time requires a SkillManager service; none is registered.');
  }
  const facts = services.createStore<RememberedFact>('remembered_facts');
  const ctx: PassContext = {
    services, settings, manager, facts,
    candidates: await buildCandidates(services, settings.blocklist),
    filed:      await fetchAll(facts, { op: 'exists', field: 'dreamSkill', value: true }),
    calls:      [],
    startedAt:  new Date().toISOString(),
    runId:      cryptoRandomId(),
  };

  // Before ranking, so a fact returned to the backlog or released from it is ranked in this very pass.
  const tended: string[] = [];
  let tending = { orphaned: 0, released: 0 };
  try { tending = await tendBacklog(ctx); }
  catch (e) { tended.push(`tending the backlog failed: ${(e as Error).message ?? String(e)}`); }

  const run = yield* rankAndMerge(ctx, ranker, merger, signal);

  let clustering: DreamRun['clustering'];
  if (grouping !== undefined && run.outcome !== 'error') {
    clustering = yield* clusterBacklog(ctx, grouping, merger, signal);
  }
  const errors = [...tended, ...(run.errors ?? [])];
  return {
    ...run,
    endedAt: new Date().toISOString(),
    ...(tending.orphaned > 0 ? { orphaned: tending.orphaned } : {}),
    ...(tending.released > 0 ? { released: tending.released } : {}),
    ...(clustering !== undefined ? { clustering } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function* rankAndMerge(
  ctx:    PassContext,
  ranker: Ranker,
  merger: Merger,
  signal: AbortSignal,
): AsyncGenerator<DreamProgress, DreamRun, void> {
  const { services, settings, manager, facts, candidates, calls, startedAt, runId } = ctx;

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
    duplicates:     0,
    backlogged:     0,
    known:          0,
    unassignedRemaining,
    judgementCalls: calls,
    ...extras,
  });

  try {
    const eligible = await fetchUnassignedFacts(facts, startedAt);
    if (eligible.length === 0) return finish('no-facts', 0);

    // ── Duplicates first, with no judgement call: a fact whose text was already decided is retired as a
    //    duplicate of it, and of several eligible facts sharing one text only the oldest (the
    //    representative) is ranked — the rest follow its disposition below. `eligible` is oldest-first, so
    //    the representative is the oldest copy. ──
    const decided = decidedKeys(ctx.filed);
    const unassigned: RememberedFact[] = [];
    const followers = new Map<string, RememberedFact[]>();
    const byKey     = new Map<string, RememberedFact>();
    let duplicates  = 0;
    const retireDuplicate = async (f: RememberedFact): Promise<void> => {
      try { await patchFact(facts, f.id, { dreamSkill: DREAM_SKILL_DUPLICATE }); duplicates++; } catch { /* raced edit */ }
    };
    for (const f of eligible) {
      const key = factKey(f.fact);
      if (decided.has(key)) { await retireDuplicate(f); continue; }
      const rep = byKey.get(key);
      if (rep === undefined) { byKey.set(key, f); unassigned.push(f); continue; }
      const behind = followers.get(rep.id);
      if (behind === undefined) followers.set(rep.id, [f]); else behind.push(f);
    }
    const followersOf = (f: RememberedFact): readonly RememberedFact[] => followers.get(f.id) ?? [];
    if (unassigned.length === 0) return finish('no-match', 0, { duplicates });
    if (candidates.length === 0) {
      // No skills to route into at all — the purest case of "the skill landscape isn't ready",
      // not a verdict on the fact. Don't burn a rank call; don't mark anything either — this
      // branch costs one cheap query per pass and no LLM call, so the fact naturally stays
      // eligible for whenever a skill appears, with no deferral bookkeeping needed.
      const primary = unassigned[0];
      if (primary === undefined) return finish('no-facts', 0);   // unreachable: length>0 above
      return finish('no-match', eligible.length - duplicates, {
        duplicates,
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
    const weak:   { fact: RememberedFact; decision: RouteDecision }[] = [];
    const none:   RememberedFact[] = [];
    let oldestDecision: RouteDecision = { decision: 'none', reasoning: '' };
    for (const f of unassigned) {
      const d = decide(f.id, byFact, settings);
      if (f.id === oldest.id) oldestDecision = d;
      if      (d.decision === 'strong') strong.push({ fact: f, decision: d });
      else if (d.decision === 'weak')   weak.push({ fact: f, decision: d });
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
      else if (d.decision === 'weak')   weak.push({ fact: f, decision: d });
      else                              stillNone.push(f);
    }

    // ── Cheap dispositions (no skill writes, no judgement calls): defer the weak + over-budget
    //    `none` facts, retire the terminal `none` facts, and move a fact weak for the
    //    weakVerdictsBeforeBacklog-th time to the backlog. Only a weak VERDICT counts: a `none` fact
    //    deferred for want of enrichment budget has not been answered yet. A CAS miss here means the fact
    //    was edited underneath us — harmless, the next pass reconsiders it — so we skip and carry on rather
    //    than abort the whole pass. ──
    const ignoreUntil = new Date(Date.parse(startedAt) + settings.weakDeferralMs).toISOString();
    let deferred = 0, retired = 0, backlogged = 0, known = 0;
    const contentOf = new Map<string, Promise<string | undefined>>();
    const skillText = (name: string): Promise<string | undefined> => {
      let p = contentOf.get(name);
      if (p === undefined) { p = manager.get(name).then(d => d?.content); contentOf.set(name, p); }
      return p;
    };
    const defer = async (g: RememberedFact): Promise<void> => {
      try { await patchFact(facts, g.id, { ignoreUntil }); deferred++; } catch { /* raced edit */ }
    };
    for (const { fact: f, decision: d } of weak) {
      const lastVerdict = { skill: d.skill ?? '', score: d.score ?? 0, reasoning: d.reasoning };
      const content     = d.skill !== undefined ? await skillText(d.skill) : undefined;
      const isKnown     = content !== undefined && alreadyStated(f.fact, content);
      let applied: FactPatch | undefined;
      try {
        applied = await patchFact(facts, f.id, fresh => {
          const weakVerdicts = (fresh.weakVerdicts ?? 0) + 1;
          if (isKnown) return { dreamSkill: DREAM_SKILL_KNOWN, weakVerdicts, lastVerdict };
          return weakVerdicts >= settings.weakVerdictsBeforeBacklog
            ? { dreamSkill: DREAM_SKILL_BACKLOG, weakVerdicts, lastVerdict }
            : { ignoreUntil, weakVerdicts, lastVerdict };
        });
      } catch { continue; /* raced edit */ }
      if (applied === undefined) continue;
      if (applied.dreamSkill === DREAM_SKILL_KNOWN) {
        known++;
        for (const g of followersOf(f)) await retireDuplicate(g);
      } else if (applied.dreamSkill === DREAM_SKILL_BACKLOG) {
        backlogged++;
        for (const g of followersOf(f)) await retireDuplicate(g);
      } else {
        deferred++;
        for (const g of followersOf(f)) await defer(g);
      }
    }
    for (const f of deferredNone) for (const g of [f, ...followersOf(f)]) await defer(g);
    for (const f of stillNone) {
      try { await patchFact(facts, f.id, { dreamSkill: DREAM_SKILL_NONE }); retired++; } catch { /* raced edit */ }
      for (const g of followersOf(f)) await retireDuplicate(g);
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
      const doc = await manager.get(skill);
      if (doc === undefined) continue;   // raced a delete between buildCandidates() and now — leave its facts for a future pass

      const cluster = members.slice(0, Math.min(settings.maxClusterSize, mergeBudget));
      let content = doc.content;
      const skillMerged: RememberedFact[] = [];
      for (const f of cluster) {
        perFactDone++;
        yield { pct: bar(), message: `Merging into "${skill}"…` };
        const mergeStart = Date.now();
        try {
          const result: MergeResult = await merger.merge(skill, content, [f], signal);
          calls.push({ role: 'merge', inputSize: 1, ms: Date.now() - mergeStart });
          content = result.content;
          for (const c of result.contradictions) allContradictions.push({ skill, location: c.location, note: c.note });
          skillMerged.push(f);
        } catch (e) {
          calls.push({ role: 'merge', inputSize: 1, ms: Date.now() - mergeStart });
          // Durable failure on THIS fact (unparseable response, or a structural guard tripped on
          // both attempts — the merger already re-rolls once, so a blip has been ruled out here).
          // Quarantine the culprit so it stops blocking the queue (needs a config fix by now),
          // stop this skill's cluster, but commit the merges that already succeeded (below) and
          // move on to the next skill rather than aborting the whole pass.
          try { await patchFact(facts, f.id, { dreamSkill: DREAM_SKILL_ERROR }); } catch { /* raced edit */ }
          quarantined++;
          mergeErrors.push(`merge failed on fact ${f.id} (skill "${skill}"): ${(e as Error).message ?? String(e)}`);
          break;
        }
      }
      if (skillMerged.length === 0) continue;
      try {
        // Skill save first so a CAS failure on a fact doesn't strand an un-saved merge.
        await manager.save(skill, content);
        for (const f of skillMerged) {
          try { await patchFact(facts, f.id, { dreamSkill: skill }); } catch { /* raced edit; fact stays eligible */ }
          mergedFactIds.push(f.id);
          for (const g of followersOf(f)) await retireDuplicate(g);
        }
        mergeBudget -= skillMerged.length;
      } catch (e) {
        // The skill save itself failed — none of this cluster's facts are marked, so they stay
        // eligible for a future pass. Record and continue with the remaining skills.
        mergeErrors.push(`saving skill "${skill}" failed: ${(e as Error).message ?? String(e)}`);
      }
    }

    const merged    = mergedFactIds.length;
    // Over-budget strong facts and their followers, and the followers of a quarantined fact: eligible next pass.
    const remaining = eligible.length - merged - deferred - retired - quarantined - duplicates - backlogged - known;
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
      duplicates,
      backlogged,
      known,
      ...(enrichedIds.has(oldest.id) ? { enriched: true } : {}),
      ...(mergeErrors.length > 0 ? { errors: mergeErrors } : {}),
    });
  } catch (e) {
    // Catch-all for anything we didn't anticipate. The run is recorded; the tool surfaces it.
    return finish('error', -1, { error: (e as Error).message ?? String(e) });
  }
}

// ── The backlog ───────────────────────────────────────────────────────────────

/** Settings keys for what a pass remembers between passes. Not tunables, so not in `DreamSettings`. */
const ROSTER_KEY     = 'dream-roster';
const CLUSTERING_KEY = 'dream-clustering';

/** The most backlogged facts one clustering call is shown, oldest first: a few hundred short facts is a
 *  few thousand tokens, and the rest wait for the next clustering. */
const MAX_CLUSTER_INPUT = 400;
/** At most this many candidates created, and groups merged into existing skills, by one clustering. Each
 *  is a whole-document LLM call, and a person reviews each candidate. */
const MAX_NEW_CANDIDATES = 3;
const MAX_HOMED_MERGES   = 5;

/** Replace a fact without its `dreamSkill` and deferral, ready to be ranked again. */
async function releaseFact(store: Store<RememberedFact>, id: string, weakVerdicts: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await store.get(id);
    if (fresh === null) return false;
    const { dreamSkill: _skill, ignoreUntil: _until, ...rest } = fresh;
    if ((await store.cas(id, fresh.version, { ...rest, weakVerdicts })).ok) return true;
  }
  return false;
}

/**
 * Before a pass ranks anything:
 *
 * - A fact filed in a skill that no longer exists (deleted, or a candidate rejected) goes back to the
 *   backlog, recording the name it was filed under. Not when the skill list is empty, which says more
 *   about the skills service than about any fact.
 * - When the ranker's roster has gained a name since the last pass, every backlogged fact gets one more
 *   ranking against it: released with one weak verdict to go, so a single weak answer sends it back. A
 *   name lost frees no fact a home, so only a gain does this. The first pass to see a roster records it.
 */
async function tendBacklog(ctx: PassContext): Promise<{ orphaned: number; released: number }> {
  const { services, manager, facts, candidates, settings } = ctx;
  let orphaned = 0, released = 0;

  const skills = await manager.all();
  if (skills.length > 0) {
    const names = new Set(skills.map(s => s.name.toLowerCase()));
    for (const f of ctx.filed) {
      const skill = f.dreamSkill;
      if (skill === undefined || SENTINELS.has(skill) || names.has(skill.toLowerCase())) continue;
      try {
        await patchFact(facts, f.id, { dreamSkill: DREAM_SKILL_BACKLOG, orphanedFrom: skill });
        f.dreamSkill = DREAM_SKILL_BACKLOG;
        orphaned++;
      } catch { /* raced edit */ }
    }
  }

  const roster = candidates.map(c => c.name.toLowerCase()).sort();
  const seen   = await services.settings().get<string[]>(ROSTER_KEY);
  if (seen !== undefined && roster.some(n => !seen.includes(n))) {
    for (const f of ctx.filed) {
      if (f.dreamSkill !== DREAM_SKILL_BACKLOG) continue;
      if (!(await releaseFact(facts, f.id, Math.max(0, settings.weakVerdictsBeforeBacklog - 1)))) continue;
      delete f.dreamSkill;   // no longer decided: the dedup below must not retire it as a copy of itself
      released++;
    }
  }
  if (seen === undefined || seen.join('\n') !== roster.join('\n')) await services.settings().set(ROSTER_KEY, roster);
  return { orphaned, released };
}

/**
 * After a pass has ranked and merged: once the backlog has grown by `clusterAfterBacklogGrowth` since the
 * last clustering, group it. A group whose home is an existing skill is merged into it in one call; a new
 * group of at least `minClusterSize` facts is written up as a candidate skill. Either way its facts are filed
 * in that skill, being in its text. The growth is measured from what the last clustering left, so a backlog
 * that clusters into nothing is not offered again until it has grown again.
 */
async function* clusterBacklog(
  ctx:      PassContext,
  grouping: { clusterer: Clusterer; writer: SkillWriter },
  merger:   Merger,
  signal:   AbortSignal,
): AsyncGenerator<DreamProgress, DreamRun['clustering'], void> {
  const { services, settings, manager, facts, candidates, calls } = ctx;
  const backlog = await fetchAll(facts, { op: 'eq', field: 'dreamSkill', value: DREAM_SKILL_BACKLOG });
  const state   = await services.settings().get<{ lastBacklog: number }>(CLUSTERING_KEY);
  if (backlog.length < settings.minClusterSize
      || backlog.length - (state?.lastBacklog ?? 0) < settings.clusterAfterBacklogGrowth) return undefined;

  yield { pct: 96, message: `Clustering ${Math.min(backlog.length, MAX_CLUSTER_INPUT)} backlogged fact(s)…` };
  const input    = backlog.slice(0, MAX_CLUSTER_INPUT);
  const byId     = new Map(input.map(f => [f.id, f]));
  const rejected = [...new Set(input.flatMap(f => (f.orphanedFrom !== undefined ? [f.orphanedFrom] : [])))];
  const created: string[] = [], mergedInto: string[] = [], declined: string[] = [], errors: string[] = [];
  let filed = 0;

  const fileUnder = async (skill: string, members: readonly RememberedFact[]): Promise<void> => {
    for (const f of members) {
      try { await patchFact(facts, f.id, { dreamSkill: skill }); filed++; } catch { /* raced edit; stays backlogged */ }
    }
  };

  try {
    const t0 = Date.now();
    let groups: readonly FactGroup[];
    try { groups = await grouping.clusterer.cluster(input, candidates, rejected, signal); }
    finally { calls.push({ role: 'cluster', inputSize: input.length, ms: Date.now() - t0 }); }

    const skills = new Map((await manager.all()).map(d => [d.name.toLowerCase(), d.name]));
    const used   = new Set<string>();
    for (const g of groups) {
      const members = [...new Set(g.members)].filter(id => byId.has(id) && !used.has(id)).map(id => byId.get(id)!);
      if (members.length === 0) continue;
      // A "new" group named as an existing skill is that skill's: never a second skill of one name.
      const home = skills.get((g.home ?? g.name).toLowerCase());
      try {
        if (home !== undefined) {
          if (mergedInto.length >= MAX_HOMED_MERGES) continue;
          const doc = await manager.get(home);
          if (doc === undefined) continue;
          const t1 = Date.now();
          let result: MergeResult;
          try { result = await merger.merge(home, doc.content, members, signal); }
          finally { calls.push({ role: 'merge', inputSize: members.length, ms: Date.now() - t1 }); }
          await manager.save(home, result.content);
          await fileUnder(home, members);
          mergedInto.push(home);
        } else {
          const name = g.name.slice(0, 80);
          if (members.length < settings.minClusterSize || created.length >= MAX_NEW_CANDIDATES || name === '' || g.asked === '') continue;
          yield { pct: 98, message: `Writing candidate skill "${name}"…` };
          const t1 = Date.now();
          let content: string | undefined;
          try { content = await grouping.writer.write({ ...g, name }, members, signal); }
          finally { calls.push({ role: 'write', inputSize: members.length, ms: Date.now() - t1 }); }
          if (content === undefined) { declined.push(name); continue; }
          await manager.save(name, content, undefined, { candidate: true });
          skills.set(name.toLowerCase(), name);
          await fileUnder(name, members);
          created.push(name);
        }
        for (const f of members) used.add(f.id);
      } catch (e) {
        errors.push(`group "${g.name}" (${members.length} facts): ${(e as Error).message ?? String(e)}`);
      }
    }
  } catch (e) {
    errors.push(`clustering failed: ${(e as Error).message ?? String(e)}`);
  }

  // Recorded whatever happened, failure included: a clusterer that fails must not be retried every pass.
  await services.settings().set(CLUSTERING_KEY, { lastBacklog: backlog.length - filed, at: new Date().toISOString() });
  return {
    backlog: input.length, candidates: created, mergedInto, filed,
    ...(declined.length > 0 ? { declined } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
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
