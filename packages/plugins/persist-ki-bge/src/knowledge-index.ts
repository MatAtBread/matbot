import type { KnowledgeIndex, KnowledgeEntry, Store, Vault } from '@matatbread/matbot-plugin-api';

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

function headingWeight(level: number): number {
  if (level === 1) return 4;
  if (level === 2) return 2;
  return 1;
}

function scoreByHeadings(content: string, terms: Array<{ term: string }>): number {
  let score = 0;
  for (const line of content.split('\n')) {
    const m = /^(#{1,3})(?!#)\s+(.+)/.exec(line);
    if (!m) continue;
    const level   = m[1]!.length;
    const heading = m[2]!.toLowerCase();
    for (const { term } of terms) {
      if (heading.includes(term.toLowerCase())) score += headingWeight(level);
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

    // Step 2: heading-weighted score (H1=4, H2=2, H3=1)
    const candidatePool = nameMatches.length > 1 ? nameMatches : all;
    const scored = candidatePool
      .map(entry => ({ entry, score: scoreByHeadings(entry.content, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    const [first, second] = scored;
    if (first !== undefined && (second === undefined || first.score >= second.score * 2)) {
      return [first.entry];
    }

    // Step 3: BGE reranker via Cloudflare Workers AI
    const apiKey    = await this.vault.resolve('${env:SKILL_RANK_API_KEY}').catch(() => undefined);
    const accountId = await this.vault.resolve('${env:CLOUDFLARE_ACCOUNT_ID}').catch(() => undefined);
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

    if (!response.ok) return first ? [first.entry] : [];

    type RerankResult = {
      success:  boolean;
      errors:   Array<unknown>;
      messages: Array<unknown>;
      result:   { response: Array<{ id: number; score: number }> };
    };
    const ranking = (await response.json()) as RerankResult;
    const best    = ranking.success
      ? ranking.result.response.slice().sort((a, b) => b.score - a.score)[0]
      : undefined;

    if (best === undefined || best.id >= rerankPool.length) {
      return first ? [first.entry] : [];
    }
    return [rerankPool[best.id]!];
  }
}
