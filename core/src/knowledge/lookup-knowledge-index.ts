import type { KnowledgeIndex, KnowledgeEntry } from '@matatbread/matbot-plugin-api';

// In-memory KnowledgeIndex for development and environments without a persistent/reranking
// backend. Entries are held in a Set; search scores each entry across its curated metadata
// (entities, tags, summary) as well as its content, then returns the clear winners.
//
// Scoring rationale — the metadata is the signal, the body is the tie-breaker. A curated entity
// match is the strongest evidence an entry is *about* a term; a heading is next; the summary is a
// tight, deliberately-written description; raw body text is the weakest (it is incidental and
// length-biased — a long document mentions everything). Body occurrences are therefore saturated
// (tf/(tf+k)), so a wordy entry can't win on sheer volume of passing mentions over a short entry
// whose curated entities name the term outright. This deliberately does NOT weight by
// procedural/informational class: that is not a relevance signal (a how-to about X is a fair match
// for X) — it lives on the entry as metadata for other consumers, not here.
const WEIGHT = {
  entityExact: 10,  // the term IS a curated entity — strongest evidence
  entityFuzzy:  4,  // the term is only a substring of an entity ("matt" in "plant matter") — weaker
  tag:          4,
  summary:      3,  // per occurrence, capped (the summary is short, so this is naturally bounded)
  headingH1:    8,
  headingH2:    5,
  headingH3:    3,
  body:         2,  // multiplied by a 0–1 saturation factor, so this is the per-term ceiling
} as const;

// Body term-frequency saturation: contribution = WEIGHT.body * tf/(tf + BODY_K). Diminishing
// returns past a couple of mentions keep long documents from dominating on raw count.
const BODY_K = 3;

// Returned window: the clear winners by cumulative-score coverage, but always offer at least MIN
// alternatives (when they exist) so a consumer can re-rank/filter, and never more than MAX.
const COVERAGE = 0.5;
const MIN_RESULTS = 3;
const MAX_RESULTS = 10;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word occurrence count, for free text (content, summary). Word-boundary matching avoids the
// substring trap — "matt" must not match "matter", "owl" must not match "fowl" — that plain
// indexOf() falls into. A multi-word term ("inner voice") is matched as a phrase.
function countWordMatches(haystack: string, term: string): number {
  const m = haystack.match(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g'));
  return m ? m.length : 0;
}

// Looser, substring-in-either-direction match for CURATED fields (entities, tags), where fuzziness
// is wanted: "matt" should match the entity "Matthew Woolf", "volvo" the entity "my volvo". Guarded
// so the contained string is at least 3 chars, keeping "us" out of "user"/"bus".
function fuzzyMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  if (a.length >= 3 && b.includes(a)) return true;
  return false;
}

function headingWeight(level: number): number {
  if (level === 1) return WEIGHT.headingH1;
  if (level === 2) return WEIGHT.headingH2;
  return WEIGHT.headingH3;
}

function scoreContent(content: string, term: string): number {
  let headingScore = 0;
  let bodyTf = 0;
  for (const line of content.split('\n')) {
    const m = /^(#{1,3})(?!#)\s+(.+)/.exec(line);
    if (m) {
      if (countWordMatches(m[2]!.toLowerCase(), term) > 0) headingScore += headingWeight(m[1]!.length);
    } else {
      bodyTf += countWordMatches(line.toLowerCase(), term);
    }
  }
  const bodyScore = bodyTf > 0 ? WEIGHT.body * (bodyTf / (bodyTf + BODY_K)) : 0;
  return headingScore + bodyScore;
}

function scoreEntry(entry: KnowledgeEntry, terms: Array<{ term: string }>): number {
  const entities = entry.entities.map(e => e.toLowerCase());
  const tags     = entry.tags.map(t => t.toLowerCase());
  const summary  = entry.summary.toLowerCase();
  let score = 0;
  for (const { term } of terms) {
    const t = term.toLowerCase().trim();
    if (t.length < 2) continue;
    // Best single entity match for this term: exact beats fuzzy-substring, and we don't stack
    // multiple entity hits for one term (one entity naming the term is the signal, not how many).
    if (entities.includes(t)) score += WEIGHT.entityExact;
    else if (entities.some(e => fuzzyMatch(e, t))) score += WEIGHT.entityFuzzy;
    if (tags.some(g => fuzzyMatch(g, t))) score += WEIGHT.tag;
    const sf = countWordMatches(summary, t);
    if (sf > 0) score += WEIGHT.summary * Math.min(sf, 2);
    score += scoreContent(entry.content, t);
  }
  return score;
}

export class LookupKnowledgeIndex implements KnowledgeIndex {
  readonly docs = new Set<KnowledgeEntry>();

  entries(): Iterable<KnowledgeEntry> {
    return this.docs;
  }

  async index(entry: KnowledgeEntry): Promise<void> {
    // Replace any existing entry with the same id.
    for (const existing of this.docs) {
      if (existing.id === entry.id) {
        this.docs.delete(existing);
        break;
      }
    }
    this.docs.add(entry);
  }

  async remove(id: string): Promise<void> {
    for (const existing of this.docs) {
      if (existing.id === id) {
        this.docs.delete(existing);
        return;
      }
    }
  }

  async search(
    terms:   Array<{ term: string; context?: string }>,
    _signal: AbortSignal,
  ): Promise<KnowledgeEntry[]> {
    if (terms.length === 0) return [];

    const scored: Array<{ entry: KnowledgeEntry; score: number }> = [];
    for (const entry of this.docs) {
      const score = scoreEntry(entry, terms);
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);

    const total = scored.reduce((sum, r) => sum + r.score, 0);
    if (total <= 0) return [];

    const target = total * COVERAGE;
    const top: KnowledgeEntry[] = [];
    let cumulative = 0;
    for (const { entry, score } of scored) {
      top.push(entry);
      cumulative += score;
      if (top.length >= MAX_RESULTS) break;
      if (top.length >= MIN_RESULTS && cumulative >= target) break;
    }
    return top;
  }
}
