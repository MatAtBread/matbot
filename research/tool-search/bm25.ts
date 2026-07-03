// Minimal BM25 over tool text, for the Phase-0 recall gate. Pure; no deps. The question this answers:
// can a lexical ranker over tool name+description beat Anthropic's built-in tool search (Arcade.dev
// measured regex 56% / bm25 64% recall@5 over 4027 tools)? If not, deferral is hopeless and we stop.

const STOP = new Set([
  'the','a','an','and','or','of','to','in','for','on','it','is','are','be','use','used','using','this',
  'that','with','from','your','you','not','one','its','as','by','at','if','when','which','what','their',
  'they','them','so','can','will','into','out','over','per','via','do','does','get','set','than','then',
]);

/** lowercase, split camelCase, split on any non-alphanumeric (incl. `_`), drop stopwords + 1-char tokens. */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !STOP.has(t));
}

export interface Doc { id: string; text: string }

export class BM25 {
  private readonly docs: { id: string; tf: Map<string, number>; len: number }[] = [];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(docs: Doc[]) {
    for (const d of docs) {
      const tokens = tokenize(d.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.docs.push({ id: d.id, tf, len: tokens.length });
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgdl = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);
  }

  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  /** Ranked ids, best first. */
  search(query: string): { id: string; score: number }[] {
    const qterms = new Set(tokenize(query));
    return this.docs
      .map(d => {
        let score = 0;
        for (const qt of qterms) {
          const f = d.tf.get(qt) ?? 0;
          if (f === 0) continue;
          score += this.idf(qt) * (f * (this.k1 + 1)) /
                   (f + this.k1 * (1 - this.b + this.b * d.len / this.avgdl));
        }
        return { id: d.id, score };
      })
      .sort((a, b) => b.score - a.score);
  }
}
