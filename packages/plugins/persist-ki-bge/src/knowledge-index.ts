import type { KnowledgeIndex, KnowledgeEntry, Store, Vault } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

const ifMissing = (e: unknown): undefined => {
  if (e instanceof MissingSecretError) return undefined;
  throw e;
};

// Selection threshold for weight-coverage results: return the top-scoring entries whose
// scores together cover this fraction of the total weight, surfacing clear winners without
// long-tail noise. Tune here to widen (higher) or narrow (lower) results.
const WEIGHT_COVERAGE_THRESHOLD = 0.5;

function topByWeightCoverage<T>(scored: Array<{ entry: T; score: number }>): T[] {
  const total = scored.reduce((sum, s) => sum + s.score, 0);
  if (total <= 0) return scored.map(s => s.entry);
  const target = total * WEIGHT_COVERAGE_THRESHOLD;
  let cumulative = 0;
  const top: T[] = [];
  for (const { entry, score } of scored) {
    top.push(entry);
    cumulative += score;
    if (cumulative >= target) break;
  }
  return top;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function normalizeAlphanum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Heading weights (H1=20, H2=10, H3=5) are 5x the body-occurrence weight of 1, so a term
// in an H2 is worth ten plain body mentions. Step 2 sees full content (the reranker only
// gets the first 1500 chars), so it can afford to count every body hit.
function headingWeight(level: number): number {
  if (level === 1) return 20;
  if (level === 2) return 10;
  return 5;
}

function countOccurrences(haystack: string, needle: string): number {
  let idx   = 0;
  let count = 0;
  for (;;) {
    const next = haystack.indexOf(needle, idx);
    if (next === -1) return count;
    count++;
    idx = next + needle.length;
  }
}

function scoreContent(content: string, terms: Array<{ term: string }>): number {
  let score = 0;
  for (const line of content.split('\n')) {
    const m = /^(#{1,3})(?!#)\s+(.+)/.exec(line);
    if (m) {
      const level   = m[1]!.length;
      const heading = m[2]!.toLowerCase();
      for (const { term } of terms) {
        if (heading.includes(term.toLowerCase())) score += headingWeight(level);
      }
    } else {
      const lower = line.toLowerCase();
      for (const { term } of terms) {
        score += countOccurrences(lower, term.toLowerCase());
      }
    }
  }
  return score;
}

export class PersistBGEKnowledgeIndex implements KnowledgeIndex {
  private readonly store: Store<KnowledgeEntry>;
  private readonly vault: Vault;

  constructor(store: Store<KnowledgeEntry>, vault: Vault) {
    this.store = store;
    this.vault = vault;
  }

  async index(entry: KnowledgeEntry): Promise<void> {
    const hash     = fnv1a(entry.content);
    const existing = await this.store.get(entry.id);
    if (existing?.contentHash === hash) return;
    await this.store.set(entry.id, { ...entry, contentHash: hash });
  }

  async search(
    terms:  Array<{ term: string; context?: string }>,
    signal: AbortSignal,
  ): Promise<KnowledgeEntry[]> {
    const { items } = await this.store.query({});
    const all = items.map(({ doc }) => doc);
    if (terms.length === 0 || all.length === 0) return [];

    // Step 1: alphanum-normalised entity match — single hit wins immediately
    const nameMatches = all.filter(entry =>
      terms.some(({ term }) => {
        const normTerm = normalizeAlphanum(term);
        return entry.entities.some(e => {
          const normEntity = normalizeAlphanum(e);
          return normEntity.includes(normTerm) || normTerm.includes(normEntity);
        });
      }),
    );

    if (nameMatches.length === 1) return nameMatches;

    // Step 2: content-weighted score — headings H1=20/H2=10/H3=5, plus 1 per body occurrence
    const candidatePool = nameMatches.length > 1 ? nameMatches : all;
    const scored = candidatePool
      .map(entry => ({ entry, score: scoreContent(entry.content, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    const [first, second] = scored;
    if (first !== undefined && (second === undefined || first.score >= second.score * 2)) {
      return [first.entry];
    }

    // Step 3: BGE reranker via Cloudflare Workers AI
    const apiKey    = await this.vault.resolve('${SKILL_RANK_API_KEY}').catch(ifMissing);
    const accountId = await this.vault.resolve('${CLOUDFLARE_ACCOUNT_ID}').catch(ifMissing);
    const rerankPool = scored.length > 0 ? scored.map(s => s.entry) : candidatePool;

    if (!apiKey || !accountId || rerankPool.length === 0) {
      return first ? [first.entry] : [];
    }

    const query    = terms.map(t => t.term).join(', ');
    const contexts = rerankPool.map(e => ({
      text: `${e.entities[0] ?? e.id}\n${e.content.slice(0, 1500)}`,
    }));

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-reranker-base`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body:   JSON.stringify({ query, contexts }),
        signal,
      },
    );

    // Surface auth/quota failures: the reranker otherwise degrades silently to heading
    // scoring, making a bad/expired token impossible to distinguish from "search got worse".
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.warn(
        `[persist-ki-bge] BGE reranker HTTP ${response.status}: ${detail.slice(0, 300)} — ` +
        `check SKILL_RANK_API_KEY / CLOUDFLARE_ACCOUNT_ID. Falling back to heading scoring.`,
      );
      return first ? [first.entry] : [];
    }

    type RerankResult = {
      success:  boolean;
      errors:   Array<unknown>;
      messages: Array<unknown>;
      result:   { response: Array<{ id: number; score: number }> };
    };
    const ranking = (await response.json()) as RerankResult;
    if (!ranking.success) {
      console.warn(
        `[persist-ki-bge] BGE reranker returned success:false: ` +
        `${JSON.stringify(ranking.errors).slice(0, 300)}. Falling back to heading scoring.`,
      );
    }
    const ranked = ranking.success
      ? ranking.result.response
          .slice()
          .sort((a, b) => b.score - a.score)
          .filter(r => r.id < rerankPool.length)
          .map(r => ({ entry: rerankPool[r.id]!, score: r.score }))
      : [];

    if (ranked.length === 0) {
      return first ? [first.entry] : [];
    }
    return topByWeightCoverage(ranked);
  }
}
