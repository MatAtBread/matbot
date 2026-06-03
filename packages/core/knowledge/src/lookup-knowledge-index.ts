import type { KnowledgeIndex, KnowledgeEntry } from '@matatbread/matbot-plugin-api';

// In-memory KnowledgeIndex for development and environments without a BGE reranker.
// Entries are held in a Set; search scores each doc by raw term-occurrence count, sorts
// descending, then returns the top docs whose cumulative score covers 50% of the total —
// surfacing clear winners quickly without drowning results in long-tail noise.
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

  async search(
    terms:  Array<{ term: string; context?: string }>,
    _signal: AbortSignal,
  ): Promise<KnowledgeEntry[]> {
    const results: Array<{ entry: KnowledgeEntry; score: number }> = [];

    for (const entry of this.docs) {
      const text = entry.content.toLowerCase();
      let score = 0;
      for (const { term } of terms) {
        const t = term.toLowerCase();
        let pos = 0;
        while ((pos = text.indexOf(t, pos)) !== -1) {
          score++;
          pos += t.length;
        }
      }
      if (score > 0) results.push({ entry, score });
    }

    results.sort((a, b) => b.score - a.score);

    const total     = results.reduce((sum, r) => sum + r.score, 0);
    const threshold = total * 0.5;
    let   cumulative = 0;
    const top: KnowledgeEntry[] = [];
    for (const { entry, score } of results) {
      top.push(entry);
      cumulative += score;
      if (cumulative >= threshold) break;
    }
    return top;
  }
}
