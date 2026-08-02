import type { Store, KnowledgeIndex, KnowledgeEntry, MatbotMachine, ItemChange } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal, ItemChangeKind } from '@matatbread/matbot-plugin-api';
import type { SkillDoc } from './types.js';

// The routing namespace the `skills` store is created under (skills/plugin.ts) — the axis a profile
// isolates and the firehose filters skill changes on. Stamped onto every emitted ItemChange.
const SKILLS_NS = 'skills';

type SkillAnalysis  = { entities: string[]; tags: string[]; summary: string; classification: { procedural: number; informational: number } };
type SkillKnowledge = NonNullable<SkillDoc['knowledge']>;

async function sha256Hex(text: string): Promise<string> {
  // SubtleCrypto is a web-platform primitive (allowed in shared packages). In a non-secure browser
  // context (plain-HTTP local hosting) `crypto.subtle` is withheld; the web-bundle loader installs a
  // SHA-256 `digest` shim before any module runs, so this stays clean and works in both runtimes.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A crude procedural/informational split from the shape of the content: three or more numbered
 *  step lines reads as a method to execute, otherwise as material to read. Used as the heuristic
 *  fallback and to fill the field when the analysis LLM omits it. */
function heuristicClassification(content: string): { procedural: number; informational: number } {
  const hasSteps = (content.match(/^\d+\.\s/gm) || []).length >= 3;
  return hasSteps ? { procedural: 0.6, informational: 0.2 } : { procedural: 0.2, informational: 0.6 };
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
    classification: heuristicClassification(doc.content),
  };
}

const ANALYSIS_SYSTEM =
`You are a knowledge extraction specialist. Given a skill's content, produce three things:

1. **summary**: A concise summary of what the skill covers, MAXIMUM 300 CHARACTERS. This will be searched against, so include key topics and terms someone might use to find this skill. Be tight — every word must earn its place.

2. **entities**: An array of important proper nouns, key terms, and concepts mentioned in the content — people, places, technologies, domain concepts. These are used for matching, so prioritize entities that are central to what the skill is about. Aim for 5-25 entities. Single words or short multi-word phrases. Include aliases where relevant.

3. **tags**: An array of broad category tags that describe the domain or topic area. Think of these as high-level classifiers. Aim for 5-12 tags. Examples: "home", "travel", "technology", "personal", "project", "reference", "automation", "France", "family", "architecture".

4. **classification**: Two independent confidence scores in [0,1] (they need NOT sum to 1) for how the skill reads. \`procedural\`: a method to execute — steps, workflows, branching, input-process-output. \`informational\`: material to read — reference, facts, narratives. A step-by-step runbook scores high procedural / low informational; a reference note scores the reverse; a skill that is both can score high on both.

Return your answer as valid JSON only — no markdown fences, no explanations. The JSON should have keys "summary" (string), "entities" (array of strings), "tags" (array of strings), "classification" (object with numeric "procedural" and "informational").`;

const ANALYSIS_TIMEOUT_MS = 6000_000;

async function analyseSkill(
  doc:      SkillDoc,
  services: MatbotMachine,
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
    // The model can omit or malform the classification without invalidating the rest; clamp what it
    // gave and fall back to the shape heuristic per-axis so the field is always present and sane.
    const c = parsed.classification as { procedural?: unknown; informational?: unknown } | undefined;
    const clamp = (v: unknown, fallback: number): number =>
      typeof v === 'number' && v >= 0 && v <= 1 ? v : fallback;
    const h = heuristicClassification(doc.content);
    const classification = {
      procedural:    clamp(c?.procedural,    h.procedural),
      informational: clamp(c?.informational, h.informational),
    };
    return { entities, tags, summary, classification };
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
  services: MatbotMachine,
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
  hidden:       boolean;
}

/**
 * The live skill set's public contract — the service advertised under `MatbotServices.SkillManager`.
 * Named after the interface (not the class) so the registry key carries an interface, per the service
 * conventions; {@link SkillManagerImpl} is the cross-runtime implementation. Skills own content and
 * catalogue advertisement only — firing a skill on a condition is the triggers subsystem's concern.
 */
export interface SkillManager {
  /** Ends with the manager (teardown). Hand to `services.mounted.observe` so a StorageBackend swap
   *  re-reads the new backend's skills, and the loop stops when the plugin unloads. */
  readonly signal: AbortSignal;
  /** The provider used to derive a skill's catalogue summary / knowledge analysis: the `analysisProvider`
   *  setting if pinned and configured, else the first configured provider (works with zero config). */
  resolveAnalysisProvider(): Promise<string>;
  /** (Re)index every persisted skill into the active KnowledgeIndex. Re-runnable: boot + each later
   *  StorageBackend swap funnel through here. This is a projection into search only — it holds no
   *  in-memory copy of the skills; catalogue reads (all/list/get) go straight to the store. */
  load(): Promise<void>;
  all(): Promise<SkillDoc[]>;
  list(): Promise<SkillSummary[]>;
  get(name: string): Promise<SkillDoc | undefined>;
  /** Create a new skill or update an existing one's content by name. `catalogue` omitted ⇒ unchanged. */
  save(name: string, content: string, catalogue?: boolean): Promise<SkillDoc>;
  /** Delete a skill by name. Returns the removed doc, or `undefined`. */
  delete(name: string): Promise<SkillDoc | undefined>;
  /** Hide or unhide a skill: hiding retracts it from the knowledge index and the catalogue
   *  advertisement (withholding it from the model) while leaving it fully manageable; unhiding
   *  re-indexes it. Orthogonal to `save` — a content edit never changes the hidden state. No-op if
   *  already in the requested state. Returns the updated doc, or `undefined` if no such skill. */
  setHidden(name: string, hidden: boolean): Promise<SkillDoc | undefined>;
  /** Import-only create: once a skill exists, the import is a no-op. Returns `true` if one was imported. */
  importIfAbsent(name: string, content: string, catalogSummary?: string): Promise<boolean>;
  /** Teardown: end the mounted-swap subscription and cancel detached analyses. */
  clear(): void;
}

/**
 * Owns the live skill set: an in-memory index keyed by lower-cased name, backed by a
 * {@link Store} for persistence and mirrored into the active {@link KnowledgeIndex}. All
 * CRUD goes through here so the cross-runtime base plugin and the node specialization
 * (which feeds it filesystem `.md` imports) share one source of truth. Constructed only
 * with web-platform primitives — no Node APIs — so it runs in the browser too.
 *
 * Skills own content and catalogue advertisement only. The firing of a skill on a condition is the
 * triggers subsystem's concern (@matatbread/matbot-triggers): a trigger invokes `skill_action(use)`
 * like any other tool, so skills carry no trigger data of their own.
 */
export class SkillManagerImpl implements SkillManager {
  // In-flight analysis per skill id, so a detached reindex can be cancelled: superseded by a newer
  // write, the skill being deleted, or teardown. Keeps it from outliving the skill or the process.
  private readonly inflight = new Map<string, AbortController>();
  private readonly store:    Store<SkillDoc>;
  private readonly services: MatbotMachine;
  // Aborts on teardown (clear()), ending the mounted-swap subscription set up in setupSkills.
  private readonly lifecycle = new AbortController();

  // Read live so a runtime register('KnowledgeIndex', …) swap is honoured (the member is a
  // capture-safe forwarding proxy, but resolving it per call keeps that guarantee explicit).
  private get knowledge(): KnowledgeIndex { return this.services.KnowledgeIndex; }

  constructor(store: Store<SkillDoc>, services: MatbotMachine) {
    this.store    = store;
    this.services = services;
  }

  /** Ends with the manager (teardown). Hand to `services.mounted.observe` so a StorageBackend swap
   *  re-reads the new backend's skills, and the loop stops when the plugin unloads. */
  get signal(): AbortSignal { return this.lifecycle.signal; }

  // The provider used to derive a skill's catalogue summary / knowledge analysis. The user pins one
  // via the `analysisProvider` setting (skills_config); absent (or stale), it falls back to the first
  // configured provider — there is always at least one — so analysis works with zero config. Resolved
  // per reindex, not cached, so a skills_config change takes effect on the next analysis without reload.
  // (analyseSkill degrades to a heuristic if this resolves to nothing, e.g. no providers at all.)
  async resolveAnalysisProvider(): Promise<string> {
    const pinned = await this.services.settings().get<string>('analysisProvider');
    if (pinned !== undefined && this.services.providers.has(pinned)) return pinned;
    return [...this.services.providers.keys()][0] ?? '';
  }

  /** (Re)index every persisted skill into the active KnowledgeIndex — a projection into search only,
   *  holding no in-memory copy. Re-runnable: the initial boot pass and every later StorageBackend swap
   *  funnel through here. Reading `this.store` (a swap-following proxy) always hits the live backend, so
   *  a swap re-indexes the new backend's skills; the old backend's in-flight analyses are cancelled. */
  async load(): Promise<void> {
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    const { items } = await this.store.query({});
    for (const doc of items) this.commit(doc, true);
  }

  // Read straight through the store — no in-memory snapshot. The proxy follows both the StorageBackend
  // swap and the current principal's partition, and a shared backend's out-of-band writes are seen too.
  // Skills are few and this runs at most once per turn (the catalogue contributor), so a full scan is
  // cheap on a local backend; a slow backend (Drive) is accelerated by a CachingStorageBackend, not here.
  async all(): Promise<SkillDoc[]> {
    const { items } = await this.store.query({});
    return items;
  }

  async list(): Promise<SkillSummary[]> {
    return (await this.all()).map(s => ({
      id:     s.id,
      name:   s.name,
      ...(s.toolBinding !== undefined ? { toolBinding: s.toolBinding } : {}),
      hidden: s.hidden ?? false,
    }));
  }

  // Skills are keyed by id in the store but addressed by name here, so this scans. Case-insensitive.
  async get(name: string): Promise<SkillDoc | undefined> {
    const key = name.toLowerCase();
    const { items } = await this.store.query({});
    return items.find(s => s.name.toLowerCase() === key);
  }

  // Publish skill CRUD (including LLM mid-turn saves via `skill_action`) onto the shared notification
  // bus — the source a UI needs to refresh its list live. Attributed to this plugin automatically;
  // `principal` is the acting identity, so a partitioned firehose can filter per connection (a
  // boot/import with none in scope is a global fact). `id` is the store id the shared-in check keys on;
  // `name` rides in advisory `detail` so a consumer that wants it need not re-fetch.
  private emitChange(operation: ItemChange['operation'], doc: Pick<SkillDoc, 'id' | 'name'>): void {
    const principal = tryCurrentPrincipal();
    this.services.Notifier.notify({
      kind: ItemChangeKind, source: 'skill', operation, namespace: SKILLS_NS, id: doc.id,
      detail: { name: doc.name },
      ...(principal !== undefined ? { principal } : {}),
    });
  }

  /** Create a new skill or update an existing one's content by name. */
  // `catalogue` (the system-prompt advertisement flag) is optional: omitted ⇒ left unchanged (the
  // common content-only save), present ⇒ set. It rides on `save` so the editor persists content,
  // triggers, and the flag in one action.
  async save(name: string, content: string, catalogue?: boolean): Promise<SkillDoc> {
    const now = new Date().toISOString();
    const doc = await this.get(name);

    if (doc === undefined) {
      const newDoc: SkillDoc = {
        id:        crypto.randomUUID(),
        version:   Date.now().toString(),
        name,
        content,
        ...(catalogue !== undefined ? { catalogue } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await this.store.set(newDoc.id, newDoc);
      this.commit(newDoc, true);
      this.emitChange('saved', newDoc);
      return newDoc;
    }

    const saved = await this.casMutate(doc, cur => this.bump({ ...cur, content, ...(catalogue !== undefined ? { catalogue } : {}) }), true);
    this.emitChange('saved', saved);
    return saved;
  }

  /** Delete a skill by name. Returns the removed doc, or `undefined`. */
  async delete(name: string): Promise<SkillDoc | undefined> {
    const doc = await this.get(name);
    if (doc === undefined) return undefined;
    this.inflight.get(doc.id)?.abort();   // no point analysing a skill we're removing
    this.inflight.delete(doc.id);
    await this.store.delete(doc.id, doc.version);
    await this.knowledge.remove(doc.id);  // retract its index entry — the store no longer owns it
    this.emitChange('deleted', doc);
    return doc;
  }

  /** Hide or unhide a skill. Hiding is a real state change (bumps version) persisted on the doc, then
   *  the index entry is retracted *awaited* — unlike the detached reindex path — so a search racing the
   *  hide can't still surface it. Unhiding re-indexes through the normal detached path (analysis may
   *  run). `hidden` is never touched by `save`, so this is the only way it changes. */
  async setHidden(name: string, hidden: boolean): Promise<SkillDoc | undefined> {
    const doc = await this.get(name);
    if (doc === undefined) return undefined;
    if ((doc.hidden ?? false) === hidden) return doc;   // already in the requested state
    const saved = await this.casMutate(doc, cur => this.bump({ ...cur, hidden }), false);
    if (hidden) {
      this.inflight.get(saved.id)?.abort();   // a pending analysis would re-index what we're retracting
      this.inflight.delete(saved.id);
      await this.knowledge.remove(saved.id);
    } else {
      void this.reindex(saved);
    }
    this.emitChange('saved', saved);
    return saved;
  }

  /**
   * Import-only create: once a skill exists, the store owns it and the import is a no-op.
   * Used by the node filesystem watcher to seed `.md` files without clobbering edits, and by
   * plugins that ship built-in skills (e.g. cognition) — hence the optional `catalogSummary`.
   * Returns `true` if a new skill was imported.
   */
  async importIfAbsent(
    name:           string,
    content:        string,
    catalogSummary?: string,
  ): Promise<boolean> {
    if (await this.get(name) !== undefined) return false;
    const now = new Date().toISOString();
    const doc: SkillDoc = {
      id:        crypto.randomUUID(),
      version:   Date.now().toString(),
      name,
      content,
      ...(catalogSummary !== undefined ? { catalogSummary } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(doc.id, doc);
    this.commit(doc, true);
    this.emitChange('saved', doc);
    return true;
  }

  clear(): void {
    this.lifecycle.abort();                                // end the mounted-swap subscription
    for (const ac of this.inflight.values()) ac.abort();   // cancel detached analyses on teardown
    this.inflight.clear();
  }

  private bump(doc: SkillDoc): SkillDoc {
    return { ...doc, version: Date.now().toString(), updatedAt: new Date().toISOString() };
  }

  // Not a cache write any more (there is no in-memory set) — just the single reindex funnel that
  // save/import/casMutate/load all route through. Kept so the KnowledgeIndex projection has one entry point.
  private commit(doc: SkillDoc, reindex: boolean): void {
    if (reindex) void this.reindex(doc);
  }

  // Detached: analysis may make an LLM call, so it must not block the write that triggered it. A
  // freshly generated analysis is cached back onto the doc (a plain store write, NOT another commit,
  // so it doesn't re-trigger reindex) so subsequent restarts re-index from cache for free.
  private async reindex(doc: SkillDoc): Promise<void> {
    this.inflight.get(doc.id)?.abort();   // supersede any in-flight analysis for this skill
    // A hidden skill is withheld from the index: retract any entry (cleans a stale persistent one on
    // boot load) and skip analysis. This is the single funnel — a content `save` of a hidden skill
    // (reindex=true) lands here too and stays retracted, so hidden survives edits.
    if (doc.hidden) {
      this.inflight.delete(doc.id);
      await this.knowledge.remove(doc.id);
      return;
    }
    const ac = new AbortController();
    this.inflight.set(doc.id, ac);
    // Analysis should be quick; cap it so a hung provider can't pin the entry forever.
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(ANALYSIS_TIMEOUT_MS)]);
    try {
      const { entry, cache } = await skillToKnowledgeEntry(doc, this.services, await this.resolveAnalysisProvider(), signal);
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
      if (r.ok) return;
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
