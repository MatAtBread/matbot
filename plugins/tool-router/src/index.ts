import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, Message, MessageContent, Tool, ToolPresenter, PresentContext } from '@matatbread/matbot-plugin-api';

// tool-router — the model never sees the whole tool library. Each provider call it sees `tool_search` plus a
// bounded WORKING SET of full tool specs, delivered through the ephemeral `tools` param (recomputed per
// loop-iteration, never persisted). `tool_search` is the tail backstop: it ranks the whole library against a
// NL query and returns a LEAN discovery record (names only) — the presenter reads those names back from the
// transcript and promotes the tools to FULL specs (desc + folded TS) in the next iteration's working set, so
// the model always selects and calls from full definitions, never from a bare summary (name+summary calling
// failed hard — models hallucinate params). Eviction is FREE: the presenter simply stops including a tool; no
// transcript rewrite. Working set = {tools called this session} ∪ {the LATEST search's candidates}; a new
// search REPLACES the candidate floor (previous un-called drop), called tools PERSIST → the set is
// byte-stable between search/call events so the tools prefix caches. EAGER_FILL additionally pre-ranks the
// current message into the working set (A/B). "Pins" are wide/low-Q fallbacks a ranker can't surface; they
// ride along in every tool_search result as a floor, DERIVED per tool from description + inputSchema, never
// name-listed. Hidden tools (trigger-driven, not model-facing) are never presented.

const TAG = '[tool-router]';
const SEARCH = 'tool_search';

// ── Windowing config (tweak with experience) ────────────────────────────────────────
// If the WHOLE library (minus hidden) plus tool_search fits in this many, present all of it — no windowing.
// Above it we window: tool_search + the working set. Raise/lower freely as the library grows.
const TARGET_WINDOW = 20;
// Threshold cull (priority 2 — bound the AVAILABLE set, not total context). The working set accumulates
// {called} ∪ {latest search's candidates}; left unchecked it drifts into the >30-50 zone where selection
// degrades. So when it exceeds CULL_TRIGGER, cut it HARD to CULL_TARGET (≈ half — "pay once, then continue")
// by turn-distance recency. A THRESHOLD (not continuous trimming) is the trigger, so between culls the set
// is stable and the tools prefix keeps caching; a cull is a rare, amortized prefix invalidation. Recency
// keeps the freshest reference of each tool (a call, or the latest search that revealed it), with the latest
// search's own rank order as the fine-grained tiebreak, so a broad search keeps its BEST matches and sheds
// the tail (low-rank matches + trailing fallbacks — all re-reachable by another search).
const CULL_TRIGGER = 20;
const CULL_TARGET  = 12;
// EAGER_FILL — false (default, Option A): the working set is purely search/call-driven; the model must
// search to surface a specialist. true: ALSO pre-rank the current user message and fold the BM25-top NEW
// tools into the working set, so an obvious tool needs no search round-trip (full specs still come from the
// registry, so it composes with lean search). Annotated `boolean` (not the literal) so the checker keeps
// both branches live. Flip to A/B the two.
const EAGER_FILL: boolean = false;
// There is deliberately NO hard-coded list of "wide"/pinned or "hidden" tool NAMES. A name like `http` or
// `find_fact` is not a stable identifier of function — the implementing plugin may be absent, or another
// plugin may register the same name with a different meaning. So which tools are "wide" (pinned) is DERIVED
// per tool from its description + inputSchema (the only universal, plugin-agnostic surface — see the width
// derivation in the extraction pass below), and `hidden` is a creation-time declaration of the synthetic-tool
// generators (tool_function / skill_compiler), never a name list here.

function textOf(content: readonly MessageContent[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && (c as { origin?: string }).origin !== 'robo')
    .map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();
}
function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return textOf(messages[i]!.content);
  return '';
}
// The working set is reconstructed read-only from the transcript each iteration (so it survives session
// edits — cut/fork/split/compact — with zero bookkeeping, and "recent" is turn-distance, not wall-clock):
//   usedTools        — every tool the model has CALLED (tool-call blocks, minus tool_search). These PERSIST.
//   latestCandidates — the names a tool_search REVEALED, but ONLY from the most recent search: a new search
//                      REPLACES this floor, so previous un-called candidates fall out of the window for free
//                      (the eviction lever). tool_search returns lean {name} records; the presenter pulls
//                      full specs from the live registry, so nothing evictable is baked into the transcript.
function usedTools(messages: readonly Message[]): Set<string> {
  const used = new Set<string>();
  for (const m of messages) for (const c of m.content)
    if (c.type === 'tool-call' && c.name !== SEARCH) used.add(c.name);
  return used;
}
function latestCandidates(messages: readonly Message[]): Set<string> {
  // The most-recent search BATCH: every tool_search call in the LATEST assistant message that issued any.
  // A model may fan out several searches in one turn (parallel tool use — Sonnet does this), and that is ONE
  // round of searching. "Last result wins" would keep only one and silently drop the others' candidates —
  // invisible on a leaky provider (still callable by name) but fatal on a strict one (Anthropic binds calls
  // to the tools param, so an un-promoted candidate is uncallable and the model re-searches / gives up).
  let batchIds = new Set<string>();
  for (const m of messages) {
    const ids: string[] = [];
    for (const c of m.content) if (c.type === 'tool-call' && c.name === SEARCH) ids.push(c.id);
    if (ids.length) batchIds = new Set(ids);                           // a newer search-issuing turn REPLACES the floor
  }
  const names = new Set<string>();
  for (const m of messages) for (const c of m.content) {
    if (c.type === 'tool-result' && batchIds.has(c.id)) {              // union the found names across the batch
      const found = (c.result as { found?: unknown } | null)?.found;
      if (Array.isArray(found)) for (const f of found) {
        const n = (f as { name?: unknown } | null)?.name;
        if (typeof n === 'string') names.add(n);
      }
    }
  }
  return names;
}
// Cull `wsNames` to its k most-recent members by turn-distance. Walk the transcript building a
// most-recently-referenced-first ordering — a tool CALL and the search that REVEALED it both count as
// references — then keep the front k. A search result's `found` is rank-ordered, so pushing it front-to-back
// leaves its top match frontmost: a broad search keeps its BEST matches and sheds the tail. Restricted to
// wsNames (an older search's un-adopted candidates were already excluded from the working set upstream).
function keepByRecency(messages: readonly Message[], wsNames: ReadonlySet<string>, k: number): Set<string> {
  const order: string[] = [];                                          // most-recent first
  const touch = (n: string): void => {
    if (!wsNames.has(n)) return;
    const i = order.indexOf(n); if (i >= 0) order.splice(i, 1);
    order.unshift(n);
  };
  const searchIds = new Set<string>();
  for (const m of messages) for (const c of m.content) {
    if (c.type === 'tool-call') { if (c.name === SEARCH) searchIds.add(c.id); else touch(c.name); }
    else if (c.type === 'tool-result' && searchIds.has(c.id)) {
      const found = (c.result as { found?: unknown } | null)?.found;
      if (Array.isArray(found)) for (let i = found.length - 1; i >= 0; i--) {   // reverse → found[0] lands frontmost
        const n = (found[i] as { name?: unknown } | null)?.name;
        if (typeof n === 'string') touch(n);
      }
    }
  }
  return new Set(order.slice(0, k));
}
function queryOf(input: unknown): string {
  return input && typeof input === 'object' && typeof (input as { query?: unknown }).query === 'string'
    ? (input as { query: string }).query : '';
}
function humanize(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '').replace(/_(action|config)$/, '').replace(/_/g, ' ').trim();
}
// djb2-xor; a content-hash cache key over name+description (collisions negligible for tool defs).
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ── BM25 ranking over the tool library (name + human description + arg names/descriptions) ──────────
const STOP = new Set(
  ('the a an of to for and or in on with your you is are be by from as at into this that it its use used using ' +
   'return returns get set list run when what which tool tools action actions manage each any one via not no data ' +
   'value input output name names describe description call calls per over about then them their').split(' '));
function tokenize(s: string): string[] {
  const w = s.replace(/_+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return (w.match(/[a-z0-9]+/g) ?? []).filter(x => x.length > 1 && !STOP.has(x));
}
function toolTokens(t: Tool): string[] {
  const human = t.description.split(/\n+TypeScript:/)[0] ?? t.description;   // drop any folded TS block
  const parts: string[] = [t.name, t.name, human];                          // name doubled = light boost
  const props = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  for (const [pn, pv] of Object.entries(props)) {
    parts.push(pn);
    const d = (pv as { description?: unknown } | null)?.description;
    if (typeof d === 'string') parts.push(d);
  }
  return tokenize(parts.join(' '));
}
// Deterministic narrow signal from the inputSchema SHAPE (no LLM, 0-error on the live corpus): a tool that
// takes no input does one fixed thing; an `action` enum is matbot's multi-action domain-tool pattern; a
// domain identifier field (sessionId, chatId, id — incl. the `action,id,…` shape store_action stamps on its
// generated store tools) ties the tool to a specific entity. All are BOUNDED ⇒ narrow (ranked, not pinned).
// It can only ever say "narrow", and no wide fallback matches, so it never causes the dangerous false-
// negative (a wide tool wrongly withheld from the pins). Everything else is "ambiguous" ⇒ the LLM decides.
function schemaSpecific(t: Tool): boolean {
  const props = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const names = Object.keys(props);
  if (names.length === 0) return true;                                       // no input → one fixed thing
  const action = props['action'] as { enum?: unknown } | undefined;
  if (action && Array.isArray(action.enum)) return true;                     // multi-action domain tool
  return names.some(n => /(^id$|Id$|_id$)/.test(n));                         // references a specific entity
}

// ONE per-tool derivation call yields both signals the router needs, from description + inputSchema (never a
// tool-name list — names aren't stable identifiers of function). The model writes the central domain NOUNS,
// then judges their WIDTH: are those nouns a bounded/named domain ("specific" → narrow, ranked) or an
// unbounded/any-instance class ("open" → wide, pinned — it answers requests that never name it, so a ranker
// can't surface it). Writing the nouns FIRST is the anchor step that makes the width judgement reliable
// (telegram_send's nouns → "Telegram/chat" ⇒ specific, where the bare action-noun "message" alone read open).
// A labelled two-line reply (not JSON) is what the weak model produces reliably and the parsers below
// tolerate partial/garbled output. System framing keeps it in extractor-mode (a bare prompt sometimes makes
// it converse or emit markdown).
const DERIVE_SYSTEM =
  'You are a tool analyst. Given a tool name and description, respond with EXACTLY two lines and nothing else:\n' +
  'NOUNS: <the central domain nouns the tool manages, queries, or acts on — a short comma-separated list>\n' +
  'WIDTH: <one word — "open" if those nouns denote an unbounded/any-instance class (any fact, any URL, the ' +
  'web, an unknown concept or entity, any shell command) so the tool could help across many unrelated ' +
  'requests; "specific" if they denote one bounded, named domain (e.g. sessions, triggers, providers, a ' +
  'platform) so it only helps within that domain>\n' +
  'No prose, no markdown, no explanation.';
function cleanNouns(raw: string): string | null {
  const s = raw.replace(/\*\*/g, '').replace(/^\s*nouns?\s*:\s*/i, '').trim();
  if (!s || s.length > 800) return null;
  if (/[?!]/.test(s)) return null;                                    // questions / refusals
  if (/\.\s/.test(s)) return null;                                    // sentence prose (lists use ", ")
  if (/\b(please|provide|i notice|i'?ll|for example|would give|sorry|unable|cannot|can'?t|no actual)\b/i.test(s)) return null;
  return s;
}
function parseWidth(raw: string): 'open' | 'specific' | null {
  const s = raw.toLowerCase();
  const o = s.search(/\b(open|wide)\b/);
  const n = s.search(/\b(specific|narrow)\b/);
  if (o >= 0 && (n < 0 || o < n)) return 'open';
  if (n >= 0 && (o < 0 || n < o)) return 'specific';
  return null;
}
// Split the two-line reply. NOUNS from its labelled line (else the whole reply, minus a WIDTH line);
// WIDTH from its labelled line specifically, so a noun that happens to read "open"/"specific" can't sway it.
function parseDerivation(raw: string): { nouns: string | null; specificity: 'open' | 'specific' | null } {
  const nounsLine = raw.match(/nouns?\s*:\s*(.+)/i)?.[1];
  const widthLine = raw.match(/width\s*:\s*(.+)/i)?.[1];
  return {
    nouns: cleanNouns(nounsLine ?? raw.replace(/width\s*:.*/i, '')),
    specificity: parseWidth(widthLine ?? ''),
  };
}
interface NounRec { id: string; version: string; tool: string; nouns: string; source: string; specificity?: string; widthBy?: string }

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    // Pin/hidden sets, DERIVED (never name-listed). `derivedWide` = tools the width derivation judged "open"
    // (wide/low-Q — capability exceeds lexical footprint, so a ranker can't surface them → always present).
    // `derivedHidden` = tools declared hidden at creation by tool_function/skill_compiler (trigger-driven,
    // not model-facing). Populated from the per-tool judgement below and from its cache, so they are live
    // even in sub-agents that skip the LLM warm-up.
    const derivedWide   = new Set<string>();
    const derivedHidden = new Set<string>();
    const isPin    = (name: string): boolean => derivedWide.has(name);
    const isHidden = (name: string): boolean => derivedHidden.has(name);

    // BM25 index over the live registry; rebuilt lazily and invalidated when the tool set changes.
    interface Idx { df: Map<string, number>; avgdl: number; docs: Map<string, string[]>; n: number }
    let idx: Idx | null = null;
    const buildIdx = (): Idx => {
      const docs = new Map<string, string[]>();
      for (const t of services.tools.list()) if (t.name !== SEARCH) docs.set(t.name, toolTokens(t));
      const df = new Map<string, number>();
      let total = 0;
      for (const toks of docs.values()) { total += toks.length; for (const w of new Set(toks)) df.set(w, (df.get(w) ?? 0) + 1); }
      return { df, avgdl: docs.size ? total / docs.size : 1, docs, n: docs.size || 1 };
    };
    const rankScored = (query: string, candidates: readonly Tool[]): { name: string; score: number }[] => {
      const ix = idx ??= buildIdx();
      const q = tokenize(query);
      const k1 = 1.5, b = 0.75;
      const idf = (w: string): number => { const d = ix.df.get(w) ?? 0; return Math.log(1 + (ix.n - d + 0.5) / (d + 0.5)); };
      const score = (toks: string[]): number => {
        const tf = new Map<string, number>(); for (const w of toks) tf.set(w, (tf.get(w) ?? 0) + 1);
        let s = 0;
        for (const w of q) { const f = tf.get(w); if (!f) continue; s += idf(w) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * toks.length / ix.avgdl)); }
        return s;
      };
      return candidates
        .map(t => ({ name: t.name, score: score(ix.docs.get(t.name) ?? toolTokens(t)) }))
        .sort((a, b) => b.score - a.score);
    };
    const rankNames = (query: string, candidates: readonly Tool[]): string[] => rankScored(query, candidates).map(r => r.name);

    console.warn(`${TAG} active — windowed (target ${TARGET_WINDOW}); pins derived per-tool from descriptions.`);

    // Nouns of every non-pinned, non-hidden tool, de-duped, form the tool_search catalogue line — priming
    // the model on what the (possibly deferred) tail can be searched for. Rebuilt as extraction fills in.
    const nounsByTool = new Map<string, string>();
    let catalogLine = '';
    const rebuildCatalog = (): void => {
      const uniq = new Map<string, string>();
      for (const [name, nouns] of nounsByTool) {
        if (name === SEARCH || isPin(name) || isHidden(name)) continue;
        for (const raw of nouns.split(',')) {
          const n = raw.trim();
          if (n && !uniq.has(n.toLowerCase())) uniq.set(n.toLowerCase(), n);
        }
      }
      const list = [...uniq.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      catalogLine = list.length ? `Tools are available for managing & querying: ${list.join(', ')}.` : '';
    };

    // tool_search: the tail backstop. Ranks a NL query against the whole library and returns FULL specs for
    // the top matches (name + description with folded TS contract + inputSchema), revealing them for the
    // session so they persist in the window and are callable. Returns everything the model needs to choose
    // and construct a call — never a bare summary.
    const toolSearch: Tool = {
      name: SEARCH,
      description:
`Find and load tools you don't currently have.

When any type of message (statement, question, narrative, complaint) appears to lack context or data, or
infers knowledge, data or a capability for which you don't already have a suitable tool, describe the
capability you need as simple verb-noun phrases such as "find sessions", "configure dreams", "update recent
users" or "identify Pradesh". Matching tools are returned as full specifications and become callable. Prefer
searching over declining or improvising.`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Describe the capability you need — the action to perform or data to fetch.' } },
        required: ['query'],
      },
      executor: {
        async *execute(input) {
          const query   = queryOf(input);
          const all     = services.tools.list().filter(t => t.name !== SEARCH && !isHidden(t.name));
          // Rank the whole library; keep the specialists that actually matched (score > 0 — drop the duds),
          // then ALWAYS append the derived-wide pins as a fallback floor. A pin has near-zero lexical overlap
          // with a specific query (bash won't match "convert video to gif"), so ranking alone can't surface
          // it — yet it's the right answer when no specialist fits. Matched specialists lead so the model
          // prefers them; the pins trail as the general-purpose backstop. Empty query → offer the library.
          const matched = query
            ? rankScored(query, all).filter(r => r.score > 0).slice(0, TARGET_WINDOW).map(r => r.name)
            : all.map(t => t.name).slice(0, TARGET_WINDOW);
          const pins    = all.filter(t => isPin(t.name)).map(t => t.name);
          const names   = [...new Set([...matched, ...pins])];
          // LEAN discovery record — names ONLY, never full specs. The presenter reads these back from the
          // transcript (latestCandidates) and promotes them to FULL specs (desc + folded TS) in the next
          // iteration's working set, where they become natively callable. Nothing evictable is baked into the
          // transcript, so eviction is just the presenter dropping them. The model must NOT construct a call
          // from this list — it selects from the full tool definitions that now appear in its tool set.
          const found = names.map(n => ({ name: n }));
          const note = matched.length
            ? `${matched.length} matching tool(s) loaded (plus general-purpose fallbacks); they now appear in your available tools with full specifications. Call the best fit from there — prefer a specific match, use a fallback only if none fit — and do not guess arguments from this list.`
            : `No specific tool matched; general-purpose fallbacks are now loaded and appear in your available tools with full specifications. Call one from there, or refine your search.`;
          yield { type: 'result', value: { found, note } };
        },
      },
    };
    services.tools.register(toolSearch);

    // Presenter — build the per-iteration window: `tool_search` + the WORKING SET (full specs, TS already
    // folded by session-runner). The working set = {tools called this session} ∪ {the latest search's
    // candidates}, both read back from the transcript. Hidden tools never appear. When the whole library
    // fits the budget, present all of it (minus hidden).
    const presenter: ToolPresenter = {
      present(tools: readonly Tool[], ctx: PresentContext): readonly Tool[] {
        try {
          const msgs = ctx.session.messages;
          const byName = new Map(tools.map(t => [t.name, t]));
          const searchRaw = byName.get(SEARCH);
          const searchTool = searchRaw && catalogLine ? { ...searchRaw, description: `${searchRaw.description}\n\n${catalogLine}` } : searchRaw;
          const candidates = tools.filter(t => t.name !== SEARCH && !isHidden(t.name));

          let window: Tool[];
          if (candidates.length + (searchTool ? 1 : 0) <= TARGET_WINDOW) {
            window = searchTool ? [searchTool, ...candidates] : [...candidates];   // whole library fits → present all
          } else {
            // Working set from the transcript: called tools persist, the latest search's candidates form the
            // (replaceable) floor. Full specs come from the live `tools` param (byName), never the transcript.
            const wsNames = new Set<string>([...usedTools(msgs), ...latestCandidates(msgs)]);
            // Threshold cull: over CULL_TRIGGER, cut HARD to CULL_TARGET by turn-distance recency. A threshold
            // (not per-call trimming) triggers it, so the set is stable — hence cache-friendly — between culls.
            const keep = wsNames.size > CULL_TRIGGER ? keepByRecency(msgs, wsNames, CULL_TARGET) : wsNames;
            let ws = candidates.filter(t => keep.has(t.name));       // registry order → stable prefix
            if (EAGER_FILL) {
              // A/B: also pre-rank THIS message and fold in the BM25-top NEW tools, so an obvious tool needs
              // no search round-trip. Full specs come from the registry, so it composes with lean search.
              const budget = Math.max(0, TARGET_WINDOW - ws.length - (searchTool ? 1 : 0));
              const fill   = rankNames(lastUserText(msgs), candidates.filter(t => !keep.has(t.name)))
                .slice(0, budget)
                .map(n => byName.get(n)).filter((t): t is Tool => !!t);
              ws = [...ws, ...fill];
            }
            window = [...(searchTool ? [searchTool] : []), ...ws];
          }
          return window;
        } catch { return tools; }                                                  // never break a turn
      },
    };
    await services.register('ToolPresenter', presenter);

    // ── Per-tool derivation: nouns (catalogue) + width (open/specific → pin/rank), content-hash cached ──
    // hash(name+description) → store → single-turn(s) on miss. The CACHE READ runs always, so `derivedWide`
    // and the catalogue are live even in sub-agents (the `background` tool's detached one-shots); only the
    // LLM warm-up on a genuine miss is skipped there (they must exit promptly, not linger doing N single-
    // turns). Content-hash key ⇒ a changed description re-derives; identical ones reuse across hot-reloads.
    // A blank/parse-fail is not cached, so it retries on the next full (non-sub-agent) boot.
    const nounStore = services.createStore<NounRec>('tool_router_nouns');
    const settings  = services.settings();
    const isSub     = services.isSubAgent();
    const provider  = async (): Promise<string | undefined> =>
      (await settings.get<string>('nounProvider').catch(() => undefined)) ?? [...services.providers.keys()][0];
    const applyWidth = (name: string, spec: string | undefined): void => {
      if (spec === 'open') derivedWide.add(name); else derivedWide.delete(name);
    };
    const seen  = new Set<string>();
    const queue: string[] = [];
    let pumping = false;
    const extractOne = async (name: string): Promise<void> => {
      const tool = services.tools.resolve(name);
      if (!tool || tool.name === SEARCH) return;
      // Content hash over EVERYTHING the derivation reads — name, description AND inputSchema — so any
      // rewrite (including a schema-only change) yields a new key and re-derives. A cache HIT therefore
      // guarantees every stored field is still valid; nouns and width are both persisted and stay fixed
      // until the next write. The store is thus the complete, always-fresh source of truth.
      const key = hash(`${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema ?? {})}`);
      if (seen.has(key)) return;
      seen.add(key);
      const cached    = await nounStore.get(key).catch(() => null);
      let nouns       = cached?.nouns;
      let specificity = cached?.specificity;
      let widthBy     = cached?.widthBy;
      let source      = cached ? 'cache' : 'uncached-fallback';
      // Width (only when not already cached): the inputSchema shape decides the narrow cases deterministically
      // (no LLM); the ambiguous rest — mostly the wide candidates — fall to the model below.
      if (specificity === undefined && schemaSpecific(tool)) { specificity = 'specific'; widthBy = 'schema'; }
      // One combined LLM call fills whatever is still missing: nouns (always, for the catalogue) and width
      // (only if the schema was ambiguous). Skipped in sub-agents (cache-only there).
      if ((nouns === undefined || specificity === undefined) && !isSub) {
        const prov = await provider();
        if (prov) {
          try {
            const out = parseDerivation((await services.singleTurn({ provider: prov, system: DERIVE_SYSTEM, prompt: `${tool.name}: ${tool.description}` })).text);
            if (nouns === undefined)                          { nouns = out.nouns ?? humanize(tool.name); source = out.nouns ? 'llm' : 'fallback'; }
            if (specificity === undefined && out.specificity) { specificity = out.specificity; widthBy = 'llm'; }
          } catch { /* keep fallbacks below */ }
          await nounStore.set(key, { id: key, version: key, tool: tool.name, nouns: nouns ?? humanize(tool.name), source,
            ...(specificity !== undefined ? { specificity } : {}), ...(widthBy !== undefined ? { widthBy } : {}) }).catch(() => {});
        }
      }
      nounsByTool.set(tool.name, nouns ?? humanize(tool.name));
      applyWidth(tool.name, specificity);
      rebuildCatalog();
    };
    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        while (queue.length) { const n = queue.shift(); if (n) await extractOne(n).catch(() => {}); }
        console.warn(`${TAG} derived wide/pinned (${derivedWide.size}): ${[...derivedWide].sort().join(', ') || '(none yet)'}`);
      } finally { pumping = false; }
    };
    const enqueue = (name: string): void => { queue.push(name); void pump(); };
    for (const t of services.tools.list()) enqueue(t.name);
    void (async () => {
      try {
        for await (const ev of services.tools.watch()) {
          idx = null;                                                    // tool set changed → rebuild BM25 index lazily
          if (ev.type === 'registered') enqueue(ev.name);
        }
      } catch { /* watch ended */ }
    })();
  },
};
