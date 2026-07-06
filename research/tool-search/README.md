# Phase-0 recall gate (tool-search)

Answers the go/no-go for the tool-search work: **can a lexical ranker over tool name+description beat
Anthropic's built-in tool search?** (Arcade.dev measured Anthropic at regex 56% / bm25 64% recall@5 over
4027 tools.) If not, deferring tools behind a search tool is hopeless and the work stops.

## Run

```
npx tsx research/tool-search/eval.ts
```

## Files

- `bm25.ts` — minimal BM25 (camelCase/`snake_case`-aware tokenizer). Pure, no deps.
- `tools.ts` — **seed** corpus: real tool descriptions harvested from matbot source. Source-defined tools
  only; runtime-generated tools (function-tools like `temperature_check`, MCP proxies like
  `mcp__anysearch__*`) are absent — they need a live-registry dump.
- `corpus.ts` — (request → expected tool) pairs, phrased in *user* vocabulary (not the tool's), to test
  real vocabulary-bridging recall. First draft — review/expand before treating as authoritative.
- `eval.ts` — runs two passes: (1) request recall@1/3/5; (2) advertised-noun recall (does a tool's
  catalogue noun retrieve the tool? — tests the "nouns are extractive" assumption behind priming-only).

## Preliminary result (2026-07-03, 27 source tools, 40 queries)

| Metric | Result |
|---|---|
| Request recall@5 | 93% (37/40) |
| Request recall@3 | 90% |
| Request recall@1 | 78% |
| Advertised-noun recall@5 | 100% (27/27) |

**Read with the scale caveat:** 27 tools ≠ thousands. Recall drops as distractors grow (RAG-MCP's
cliff past ~100 tools), so this is a strong *signal* with headroom, not an apples-to-apples beat of
Anthropic's 64%@4027. The advertised-noun 100%@5 validates priming-only (nouns are extractive → no
index-enrichment needed). The 3 request misses are all BM25 vocabulary gaps (conversations≠sessions,
clean-up≠compact, download/file collision) — precisely where the noun-catalog priming and a BGE
reranker earn their place.

## Authoritative run (TODO)

1. Dump the **live** tool registry (`services.tools.list()` → `[{name, description}]`, with wire
   contracts folded in) — includes runtime tools. Replace/extend `tools.ts`.
2. Expand/review `corpus.ts` against the full set; add the `temperature_check → "turn up the heating"`
   inferential-noun case (the one that could break priming-only).
3. Re-run; compare recall@5 at real scale to 64%.
