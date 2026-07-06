// Phase-0 recall gate. Run: `npx tsx research/tool-search/eval.ts`
//
// Two questions:
//   1. Request recall — given a user's phrasing, does BM25 over tool name+description surface the right
//      tool in the top K? Compare recall@5 to Anthropic's built-in (Arcade.dev: regex 56% / bm25 64%).
//   2. Advertised-noun recall — does searching a tool's *catalogue noun* retrieve that tool? This tests
//      the design assumption that catalogue nouns are EXTRACTIVE (present in the description). Where a
//      noun is blank (session_edit), it falls back to the tool name, exactly as the plugin will.

import { BM25 } from './bm25.ts';
import { TOOLS } from './tools.ts';
import { CORPUS } from './corpus.ts';

// Advertised nouns from the matbot+inner-voice extraction (2026-07-03), for tools present in tools.ts.
// '' = the extractor drew a blank → the plugin falls back to the tool name.
const NOUNS: Record<string, string> = {
  about_matbot: 'harness version', whoami: 'security principal', http: 'request response body',
  workspace_action: 'workspace', url_for_resource: 'URL file', background: 'background process prompt',
  every_action: 'schedules', ask_inner_voice: 'inner voice', single_turn: 'completion', find_fact: 'fact',
  contextual_search: 'concept system term entity', remember_fact: 'facts', dream_time: 'memory consolidation',
  skill_action: 'skills', skill_compiler: 'skill plugin', telegram_provider: 'LLM provider telegram bot',
  telegram_send: 'notification', telegram_open_door: 'door', mcp_action: 'connections', plugin: 'plugins',
  session_action: 'session', session_edit: '', compact_sessions: 'session compaction policy session store',
  store_action: 'store', trigger_action: 'trigger', triggers_config: 'triggers subsystem',
  skills_config: 'skills subsystem',
};

const bm25 = new BM25(TOOLS.map(t => ({ id: t.name, text: `${t.name}. ${t.description}` })));
const rankOf = (query: string, expected: string): number =>
  bm25.search(query).map(r => r.id).indexOf(expected);

function recall(pairs: { query: string; expected: string; label?: string }[], ks: number[]): void {
  const hits = new Map<number, number>(ks.map(k => [k, 0]));
  const misses: string[] = [];
  for (const { query, expected, label } of pairs) {
    const rank = rankOf(query, expected);
    for (const k of ks) if (rank >= 0 && rank < k) hits.set(k, hits.get(k)! + 1);
    if (rank < 0 || rank >= Math.max(...ks)) {
      const top = bm25.search(query).slice(0, 3).map(r => r.id).join(', ');
      misses.push(`  ✗ "${label ?? query}" → want ${expected}; got [${top}]`);
    }
  }
  const n = pairs.length;
  for (const k of ks) console.log(`   recall@${k}: ${(hits.get(k)! / n * 100).toFixed(0)}%  (${hits.get(k)}/${n})`);
  if (misses.length) console.log(misses.join('\n'));
}

console.log(`\n=== Phase-0 recall gate — BM25 over ${TOOLS.length} tools ===`);
console.log(`Baseline to beat (Arcade.dev, 4027 tools): regex 56% / bm25 64% recall@5\n`);

console.log(`[1] Request recall (${CORPUS.length} user-phrased queries):`);
recall(CORPUS, [1, 3, 5]);

console.log(`\n[2] Advertised-noun recall (does the catalogue noun retrieve its own tool?):`);
const nounPairs = Object.entries(NOUNS).map(([name, noun]) => ({
  query:    noun || name.replace(/_/g, ' '),   // blank noun ⇒ fall back to the tool name
  expected: name,
  label:    noun ? `${name}: "${noun}"` : `${name}: (blank→name)`,
}));
recall(nounPairs, [1, 5]);
