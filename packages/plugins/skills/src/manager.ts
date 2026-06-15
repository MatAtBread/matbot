import type { Store, KnowledgeIndex, KnowledgeEntry, MatbotServices } from '@matatbread/matbot-plugin-api';
import type { SkillDoc, SkillTrigger, TriggerPhase } from './types.js';

type SkillAnalysis  = { entities: string[]; tags: string[]; summary: string };
type SkillKnowledge = NonNullable<SkillDoc['knowledge']>;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Cheap, deterministic analysis from the skill's name and tags — the fallback when no analysis
 *  provider is configured (or the LLM call fails). Cheap enough that it is never worth caching. */
function heuristicAnalysis(doc: SkillDoc): SkillAnalysis {
  const nameLower  = doc.name.toLowerCase();
  const nameTokens = nameLower.split(/[\s\-_]+/).filter(t => t.length > 1);
  return {
    entities: [...new Set([doc.name, nameLower, ...nameTokens])],
    tags:     doc.tags ?? [],
    summary:  doc.content.slice(0, 500),
  };
}

const ANALYSIS_SYSTEM =
`You are a knowledge extraction specialist. Given a skill's content, produce three things:

1. **summary**: A concise summary of what the skill covers, MAXIMUM 300 CHARACTERS. This will be searched against, so include key topics and terms someone might use to find this skill. Be tight — every word must earn its place.

2. **entities**: An array of important proper nouns, key terms, and concepts mentioned in the content — people, places, technologies, domain concepts. These are used for matching, so prioritize entities that are central to what the skill is about. Aim for 5-25 entities. Single words or short multi-word phrases. Include aliases where relevant.

3. **tags**: An array of broad category tags that describe the domain or topic area. Think of these as high-level classifiers. Aim for 5-12 tags. Examples: "home", "travel", "technology", "personal", "project", "reference", "automation", "France", "family", "architecture".

Return your answer as valid JSON only — no markdown fences, no explanations. The JSON should have keys "summary" (string), "entities" (array of strings), "tags" (array of strings).`;

const ANALYSIS_TIMEOUT_MS = 6000_000;

async function analyseSkill(
  doc:      SkillDoc,
  services: MatbotServices,
  provider: string,
  signal?:  AbortSignal,
): Promise<SkillAnalysis | undefined> {
  if (!services.providers.has(provider)) return undefined;
  try {
    const res = await services.singleTurn({
      provider,
      system: ANALYSIS_SYSTEM,
      prompt: doc.content,
      ...(signal !== undefined ? { signal } : {}),
    });
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) {
      console.warn(`[skills] analysis for ${doc.name} unparseable:`, res.text);
      return undefined;
    }
    const parsed = JSON.parse(m[0]) as Partial<SkillAnalysis>;
    const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const entities = strings(parsed.entities);
    const tags     = strings(parsed.tags);
    const summary  = typeof parsed.summary === 'string' ? parsed.summary : '';
    if (entities.length === 0 && summary === '') return undefined;
    return { entities, tags, summary };
  } catch (e) {
    if (signal?.aborted) return undefined;   // superseded/timed out — reindex owns the message
    console.warn(`[skills] analysis for ${doc.name} failed:`, e);
    return undefined;
  }
}

function buildEntry(doc: SkillDoc, a: SkillAnalysis, contentHash: string): KnowledgeEntry {
  return {
    id:        doc.id,
    version:   doc.version,
    entities:  a.entities,
    tags:      a.tags,
    summary:   a.summary,
    content:   doc.content,
    contentHash,
    source:    { type: 'skill', uuid: doc.id },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Build the {@link KnowledgeEntry} for a skill, generating its entities/tags/summary with an LLM
 * (`singleTurn` on `provider`) so the skill is well-described for semantic search. The analysis has
 * a real cost, so it is keyed on a SHA-256 of the content: an unchanged skill reuses the cache on
 * `doc.knowledge` and makes no LLM call. A freshly generated analysis is returned in `cache` for the
 * caller to persist back onto the doc; a heuristic fallback (no provider, or a failed/empty call) is
 * returned without a `cache`, so it is re-derived next time rather than masking a later real analysis.
 */
export async function skillToKnowledgeEntry(
  doc:      SkillDoc,
  services: MatbotServices,
  provider: string,
  signal?:  AbortSignal,
): Promise<{ entry: KnowledgeEntry; cache?: SkillKnowledge }> {
  const contentHash = await sha256Hex(doc.content);

  if (doc.knowledge?.contentHash === contentHash) {
    return { entry: buildEntry(doc, doc.knowledge, contentHash) };
  }

  const analysed = await analyseSkill(doc, services, provider, signal);
  if (analysed === undefined) {
    return { entry: buildEntry(doc, heuristicAnalysis(doc), contentHash) };
  }
  const cache: SkillKnowledge = { contentHash, ...analysed };
  return { entry: buildEntry(doc, cache, contentHash), cache };
}

export interface SkillSummary {
  id:           string;
  name:         string;
  toolBinding?: string;
}

/**
 * Owns the live skill set: an in-memory index keyed by lower-cased name, backed by a
 * {@link Store} for persistence and mirrored into the active {@link KnowledgeIndex}. All
 * CRUD goes through here so the cross-runtime base plugin and the node specialization
 * (which feeds it filesystem `.md` imports) share one source of truth. Constructed only
 * with web-platform primitives — no Node APIs — so it runs in the browser too.
 *
 * Triggers are embedded in the {@link SkillDoc}, so they version, persist, and delete with
 * their owning skill (referential integrity is structural). But they are managed *separately*
 * from content — `save` never touches triggers, and trigger mutations skip knowledge
 * re-indexing — because content is consumed by the model and triggers are not.
 */
export class SkillManager {
  private readonly skills = new Map<string, SkillDoc>();
  // In-flight analysis per skill id, so a detached reindex can be cancelled: superseded by a newer
  // write, the skill being deleted, or teardown. Keeps it from outliving the skill or the process.
  private readonly inflight = new Map<string, AbortController>();
  private readonly store:    Store<SkillDoc>;
  private readonly services: MatbotServices;
  private readonly analysisProvider: string;

  // Read live so a runtime register('KnowledgeIndex', …) swap is honoured (the member is a
  // capture-safe forwarding proxy, but resolving it per call keeps that guarantee explicit).
  private get knowledge(): KnowledgeIndex { return this.services.KnowledgeIndex; }

  constructor(store: Store<SkillDoc>, services: MatbotServices, analysisProvider: string) {
    this.store            = store;
    this.services         = services;
    this.analysisProvider = analysisProvider;
  }

  /** Load persisted skills into memory and index each one. */
  async init(): Promise<void> {
    const { items } = await this.store.query({});
    for (const { doc } of items) this.commit(doc, true);
  }

  all(): SkillDoc[] {
    return [...this.skills.values()];
  }

  list(): SkillSummary[] {
    return this.all().map(s => ({
      id:   s.id,
      name: s.name,
      ...(s.toolBinding !== undefined ? { toolBinding: s.toolBinding } : {}),
    }));
  }

  get(name: string): SkillDoc | undefined {
    return this.skills.get(name.toLowerCase());
  }

  /** Create a new skill or update an existing one's content by name. Leaves triggers untouched. */
  async save(name: string, content: string): Promise<SkillDoc> {
    const now = new Date().toISOString();
    const key = name.toLowerCase();
    const doc = this.skills.get(key);

    if (doc === undefined) {
      const newDoc: SkillDoc = {
        id:        crypto.randomUUID(),
        version:   Date.now().toString(),
        name,
        content,
        triggers:  [],
        createdAt: now,
        updatedAt: now,
      };
      await this.store.set(newDoc.id, newDoc);
      this.commit(newDoc, true);
      return newDoc;
    }

    return this.casMutate(doc, cur => this.bump({ ...cur, content }), true);
  }

  /** Delete a skill (and its embedded triggers) by name. Returns the removed doc, or `undefined`. */
  async delete(name: string): Promise<SkillDoc | undefined> {
    const key = name.toLowerCase();
    const doc = this.skills.get(key);
    if (doc === undefined) return undefined;
    this.inflight.get(doc.id)?.abort();   // no point analysing a skill we're removing
    this.inflight.delete(doc.id);
    await this.store.delete(doc.id, doc.version);
    this.skills.delete(key);
    return doc;
  }

  /** Append one trigger; mints and returns its id. `undefined` if the skill does not exist. */
  async addTrigger(name: string, phase: TriggerPhase, trigger: string): Promise<{ doc: SkillDoc; id: string } | undefined> {
    const doc = this.get(name);
    if (doc === undefined) return undefined;
    const id = crypto.randomUUID();
    const updated = await this.casMutate(doc, cur => this.bump({
      ...cur,
      triggers: [...(cur.triggers ?? []), { id, phase, trigger }],
    }), false);
    return { doc: updated, id };
  }

  /** Edit one trigger by id. `'no-trigger'` if the id is absent, `undefined` if the skill is. */
  async updateTrigger(
    name: string,
    id:   string,
    patch: { trigger?: string; phase?: TriggerPhase },
  ): Promise<SkillDoc | undefined | 'no-trigger'> {
    const doc = this.get(name);
    if (doc === undefined) return undefined;
    if (!(doc.triggers ?? []).some(t => t.id === id)) return 'no-trigger';
    return this.casMutate(doc, cur => this.bump({
      ...cur,
      triggers: (cur.triggers ?? []).map(t => t.id === id ? { ...t, ...patch } : t),
    }), false);
  }

  /** Remove one trigger by id. `'no-trigger'` if the id is absent, `undefined` if the skill is. */
  async removeTrigger(name: string, id: string): Promise<SkillDoc | undefined | 'no-trigger'> {
    const doc = this.get(name);
    if (doc === undefined) return undefined;
    if (!(doc.triggers ?? []).some(t => t.id === id)) return 'no-trigger';
    return this.casMutate(doc, cur => this.bump({
      ...cur,
      triggers: (cur.triggers ?? []).filter(t => t.id !== id),
    }), false);
  }

  /**
   * Import-only create: once a skill exists, the store owns it and the import is a no-op.
   * Used by the node filesystem watcher to seed `.md` files without clobbering edits, and by
   * plugins that ship built-in skills (e.g. cognition) — hence the optional `triggers`, each of
   * which is minted a fresh id here. Returns `true` if a new skill was imported.
   */
  async importIfAbsent(
    name:     string,
    content:  string,
    triggers: readonly Omit<SkillTrigger, 'id'>[] = [],
  ): Promise<boolean> {
    const key = name.toLowerCase();
    if (this.skills.has(key)) return false;
    const now = new Date().toISOString();
    const doc: SkillDoc = {
      id:        crypto.randomUUID(),
      version:   Date.now().toString(),
      name,
      content,
      triggers:  triggers.map(t => ({ id: crypto.randomUUID(), phase: t.phase, trigger: t.trigger })),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(doc.id, doc);
    this.commit(doc, true);
    return true;
  }

  clear(): void {
    for (const ac of this.inflight.values()) ac.abort();   // cancel detached analyses on teardown
    this.inflight.clear();
    this.skills.clear();
  }

  private bump(doc: SkillDoc): SkillDoc {
    return { ...doc, version: Date.now().toString(), updatedAt: new Date().toISOString() };
  }

  private commit(doc: SkillDoc, reindex: boolean): void {
    this.skills.set(doc.name.toLowerCase(), doc);
    if (reindex) void this.reindex(doc);
  }

  // Detached: analysis may make an LLM call, so it must not block the write that triggered it. A
  // freshly generated analysis is cached back onto the doc (a plain store write, NOT another commit,
  // so it doesn't re-trigger reindex) so subsequent restarts re-index from cache for free.
  private async reindex(doc: SkillDoc): Promise<void> {
    this.inflight.get(doc.id)?.abort();   // supersede any in-flight analysis for this skill
    const ac = new AbortController();
    this.inflight.set(doc.id, ac);
    // Analysis should be quick; cap it so a hung provider can't pin the entry forever.
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(ANALYSIS_TIMEOUT_MS)]);
    try {
      const { entry, cache } = await skillToKnowledgeEntry(doc, this.services, this.analysisProvider, signal);
      if (ac.signal.aborted) return;      // superseded/deleted mid-analysis — a newer pass (or none) wins
      // Timeout (not supersession): the entry fell back to the heuristic. Index it so the skill is
      // still findable, but it stays uncached so a later pass can retry the analysis. (Future: mark
      // timed-out skills for off-line analysis instead.)
      if (signal.aborted) console.warn(`[skills] analysis timed out (${ANALYSIS_TIMEOUT_MS}ms) for ${doc.name}; indexed from heuristic`);
      if (cache !== undefined) await this.cacheKnowledge(doc.id, cache);
      await this.knowledge.index(entry);
    } catch (e) {
      console.warn(`[skills] reindex failed for ${doc.name}:`, e);
    } finally {
      if (this.inflight.get(doc.id) === ac) this.inflight.delete(doc.id);
    }
  }

  private async cacheKnowledge(id: string, knowledge: SkillKnowledge): Promise<void> {
    for (;;) {
      const cur = await this.store.get(id);
      if (cur === null) return;                                   // deleted meanwhile
      if (cur.knowledge?.contentHash === knowledge.contentHash) return; // already current
      const next: SkillDoc = { ...cur, version: Date.now().toString(), knowledge };
      const r = await this.store.cas(id, cur.version, next);
      if (r.ok) { this.skills.set(next.name.toLowerCase(), next); return; }
    }
  }

  private async casMutate(doc: SkillDoc, mutate: (cur: SkillDoc) => SkillDoc, reindex: boolean): Promise<SkillDoc> {
    let cur = doc;
    for (;;) {
      const next = mutate(cur);
      const r = await this.store.cas(cur.id, cur.version, next);
      if (r.ok) { this.commit(next, reindex); return next; }
      const fresh = await this.store.get(cur.id);
      if (fresh === null) {
        await this.store.set(next.id, next);
        this.commit(next, reindex);
        return next;
      }
      cur = fresh;
    }
  }
}
