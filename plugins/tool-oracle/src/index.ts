import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, Message, MessageContent, Tool, ToolPresenter, PresentContext, Session } from '@matatbread/matbot-plugin-api';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Oracle instrument, SEARCH-FIRST. The model is shown only `tool_search`; to do anything it must
// describe the capability it needs (that query is input (b) — the model's own sanitised rephrasing of
// the user message (a)). `tool_search` returns EVERY tool (no filtering = the unbiased oracle) and
// reveals them for the turn, so the model then picks from the full set. This does two things a
// present-everything instrument can't: it captures the query, and — running live — it is the first
// mechanical proof that routing tool-use through search→reveal→pick is a TRANSPARENT SUBSTITUTION for
// direct presentation. It's also the real production scaffold: swap tool_search's "return all" for
// "rank + cull" and the presenter's reveal-set becomes the live filter.
//
// JSONL (.data/tool-oracle.jsonl):
//   { t:'turn',   request, toolCount }   — every turn (incl. no-search = negatives)
//   { t:'search', request, query }       — the model's tool_search query (b)
//   { t:'call',   request, tool, input } — the tool it then picked from the full set (the label)
//   { t:'nouns',  tool, nouns, source }  — a tool's extracted nouns (feeds the tool_search catalogue)

const TAG = '[tool-oracle]';
const SEARCH = 'tool_search';

// Tools always presented alongside tool_search — the "wired pages": general fallbacks that catch queries
// no specific tool matches (e.g. contextual_search). EMPTY for now. Their nouns are excluded from the
// catalogue (they're already on the table); with this empty, the un-presented set = everything but
// tool_search.
const ALWAYS_PRESENT: readonly string[] = [];

function textOf(content: readonly MessageContent[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && (c as { origin?: string }).origin !== 'robo')
    .map(c => c.text).join(' ').replace(/\s+/g, ' ').trim();
}
function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return textOf(messages[i]!.content);
  return '';
}
function lastUserMsgId(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return messages[i]!.id;
  return '';
}
function isTurnStart(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === 'marker') continue;
    return role === 'user';
  }
  return false;
}
function firstLine(s: string): string {
  const line = s.split('\n', 1)[0] ?? '';
  return line.length > 120 ? line.slice(0, 117) + '…' : line;
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
// System framing keeps the model in extractor-mode — a bare user prompt sometimes makes it converse
// ("please provide the description", "I notice this is an MCP tool…") or add markdown instead of nouns.
const NOUN_SYSTEM =
  'You are a keyword extractor. Given a tool name and description, respond with ONLY the central domain ' +
  'nouns the tool manages, queries, or acts on — a short comma-separated list. No prose, no markdown, ' +
  'no questions, no labels, no explanation.';
// Safety net: reject anything that still looks like prose/refusal/markdown so it never reaches the
// catalogue (fall back to the tool name instead). A real noun list has commas, not sentences/questions.
function cleanNouns(raw: string): string | null {
  const s = raw.replace(/\*\*/g, '').replace(/^\s*nouns?\s*:\s*/i, '').trim();
  if (!s || s.length > 800) return null;
  if (/[?!]/.test(s)) return null;                                    // questions / refusals
  if (/\.\s/.test(s)) return null;                                    // sentence prose (lists use ", ")
  if (/\b(please|provide|i notice|i'?ll|for example|would give|sorry|unable|cannot|can'?t|no actual)\b/i.test(s)) return null;
  return s;
}
interface NounRec { id: string; version: string; tool: string; nouns: string; source: string }

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    const dir     = join(dirname(services.configPath ?? '.'), '.data');
    const logPath = join(dir, 'tool-oracle.jsonl');
    await mkdir(dir, { recursive: true }).catch(() => {});
    const log = (rec: unknown): void => { void appendFile(logPath, JSON.stringify(rec) + '\n', 'utf8').catch(() => {}); };

    // Per-turn reveal: once tool_search runs this turn, present ALL tools so the model can pick.
    const searched  = new Set<string>();                               // `${sessionId}|${lastUserMsgId}`
    const turnKey   = (s: Session): string => `${s.id}|${lastUserMsgId(s.messages)}`;

    console.warn(`${TAG} active — SEARCH-FIRST oracle: present only ${SEARCH}; it returns ALL tools; logging → ${logPath}`);

    // tool_search: the entry point. Returns every tool (oracle: no filtering) and reveals them.
    const toolSearch: Tool = {
      name: SEARCH,
      description:
        `Find and load tools you don't currently have. Most tools aren't shown up front — when a request ` +
        `needs an action or data and you don't already have a suitable tool, describe the capability you ` +
        `need in natural language and matching tools are returned and become callable. Prefer searching ` +
        `over declining or improvising.`,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Describe the capability you need — the action to perform or data to fetch.' } },
        required: ['query'],
      },
      executor: {
        async *execute(_input, ctx) {
          if (ctx.session) searched.add(turnKey(ctx.session));         // reveal all tools for this turn
          const all = services.tools.list().filter(t => t.name !== SEARCH);
          const found = all.map(t => ({ name: t.name, summary: firstLine(t.description) }));
          yield { type: 'result', value: { found, note: `${found.length} tools available (all returned — no filtering). Call whichever fits the request.` } };
        },
      },
    };
    services.tools.register(toolSearch);

    // Nouns of the UN-PRESENTED (deferred) tools, de-duped, form the tool_search catalogue line — so the
    // model is told what areas it can search for. Rebuilt as extraction fills `nounsByTool`; injected at
    // present() time (reflects exactly what THIS turn defers) rather than baked into the registered
    // description. Empty until extraction has run (and stays empty in sub-agents, where extraction is
    // skipped) — then tool_search shows its plain description.
    const nounsByTool = new Map<string, string>();     // tool name → its extracted nouns (comma-separated)
    let catalogLine = '';
    const rebuildCatalog = (): void => {
      const uniq = new Map<string, string>();          // lowercased key → first-seen original casing
      for (const [name, nouns] of nounsByTool) {
        if (name === SEARCH || ALWAYS_PRESENT.includes(name)) continue;
        for (const raw of nouns.split(',')) {
          const n = raw.trim();
          if (n && !uniq.has(n.toLowerCase())) uniq.set(n.toLowerCase(), n);
        }
      }
      const list = [...uniq.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      catalogLine = list.length ? `Tools are available for managing & querying: ${list.join(', ')}.` : '';
    };

    // Present only tool_search until it has been called this turn; then present everything.
    const presenter: ToolPresenter = {
      present(tools: readonly Tool[], ctx: PresentContext): readonly Tool[] {
        try {
          const msgs = ctx.session.messages;
          if (isTurnStart(msgs)) {
            log({ t: 'turn', ts: new Date().toISOString(), session: ctx.session.id, provider: ctx.provider, request: lastUserText(msgs), toolCount: tools.length });
          }
          if (!searched.has(turnKey(ctx.session))) {
            const ts = tools.find(t => t.name === SEARCH);
            if (ts) {
              // search-first: present tool_search (description augmented with the catalogue of the
              // un-presented set) + any always-present fallbacks.
              const search = catalogLine ? { ...ts, description: `${ts.description}\n\n${catalogLine}` } : ts;
              const pinned = tools.filter(t => t.name !== SEARCH && ALWAYS_PRESENT.includes(t.name));
              return [search, ...pinned];
            }
          }
        } catch { /* never let instrumentation break a turn */ }
        return tools;                                                  // revealed (or defensive): present all
      },
    };
    await services.register('ToolPresenter', presenter);

    // Record the query (b) and the subsequent pick (the oracle label).
    services.hooks.register({
      on: 'toolcall',
      handler(ctx) {
        try {
          const request = lastUserText(ctx.session.messages);
          const base = { ts: new Date().toISOString(), session: ctx.session.id, provider: ctx.config.provider, request };
          if (ctx.toolCall.name === SEARCH) log({ t: 'search', ...base, query: queryOf(ctx.toolCall.input) });
          else                               log({ t: 'call',   ...base, tool: ctx.toolCall.name, input: ctx.toolCall.input });
        } catch { /* observer only */ }
      },
    });

    // Noun extraction below is background warm-up (~one single-turn per uncached tool). Skip it in
    // spawned sub-agents (the `background` tool's detached one-shots) — they must exit promptly, not
    // linger doing N single-turns. Left running for the long-lived server/REPL, where it warms the
    // cache over the first minute and is a no-op on subsequent boots. (A manual single-turn CLI run is
    // not a sub-agent, so it will still warm the cache and linger accordingly — rare/dev only.)
    if (services.isSubAgent()) return;

    // ── Noun extraction (DATA for the analysis, not presentation) ──────────────────
    // hash(name+description) → nouns store → single-turn on miss. Caches the RESOLVED nouns (so a
    // genuine blank falls back to the tool name and a transient boot failure doesn't poison the cache
    // — it retries next boot). De-duped these become the tool_search catalogue later; logged as
    // {t:'nouns'} so the analysis can relate a tool's description ↔ its nouns ↔ the queries the model
    // forms. Runs on load + services.tools.watch(); sequential (rate-limit-safe); one-time per unique
    // description (cached across reloads).
    const nounStore    = services.createStore<NounRec>('tool-oracle-nouns');
    const settings     = services.settings();
    const nounProvider = async (): Promise<string | undefined> =>
      (await settings.get<string>('nounProvider').catch(() => undefined)) ?? [...services.providers.keys()][0];
    const seen  = new Set<string>();
    const queue: string[] = [];
    let pumping = false;
    const extractOne = async (name: string): Promise<void> => {
      const tool = services.tools.resolve(name);
      if (!tool || tool.name === SEARCH) return;
      const key = hash(`${tool.name}\n${tool.description}`);
      if (seen.has(key)) return;
      seen.add(key);
      let nouns: string;
      let source: string;
      const cached = await nounStore.get(key).catch(() => null);
      if (cached) {
        nouns = cached.nouns; source = 'cache';
      } else {
        let text: string | undefined;
        const prov = await nounProvider();
        if (prov) {
          try { text = (await services.singleTurn({ provider: prov, system: NOUN_SYSTEM, prompt: `${tool.name}: ${tool.description}` })).text; }
          catch { text = undefined; }
        }
        if (text !== undefined) {                                 // call returned → validate; cache the resolved value
          const cleaned = cleanNouns(text);
          nouns  = cleaned ?? humanize(tool.name);                 // reject prose/refusal → fall back to the name
          source = cleaned ? 'llm' : 'fallback';
          await nounStore.set(key, { id: key, version: key, tool: tool.name, nouns, source }).catch(() => {});
        } else {                                                  // no provider / transient failure → don't cache; retry next boot
          nouns = humanize(tool.name); source = 'uncached-fallback';
        }
      }
      nounsByTool.set(tool.name, nouns);                          // feed the catalogue
      rebuildCatalog();
      log({ t: 'nouns', ts: new Date().toISOString(), tool: tool.name, hash: key, nouns, source });
    };
    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        while (queue.length) { const n = queue.shift(); if (n) await extractOne(n).catch(() => {}); }
        console.warn(`${TAG} catalogue (${nounsByTool.size} tools): ${catalogLine || '(empty)'}`);
      } finally { pumping = false; }
    };
    const enqueue = (name: string): void => { queue.push(name); void pump(); };
    for (const t of services.tools.list()) enqueue(t.name);
    void (async () => { try { for await (const ev of services.tools.watch()) if (ev.type === 'registered') enqueue(ev.name); } catch { /* watch ended */ } })();
  },
};
