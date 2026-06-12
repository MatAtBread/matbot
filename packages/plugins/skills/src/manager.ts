import type { Store, KnowledgeIndex, KnowledgeEntry } from '@matatbread/matbot-plugin-api';
import type { SkillDoc, TriggerPhase } from './types.js';

export function skillToKnowledgeEntry(doc: SkillDoc): KnowledgeEntry {
  const nameLower  = doc.name.toLowerCase();
  const nameTokens = nameLower.split(/[\s\-_]+/).filter(t => t.length > 1);
  return {
    id:        doc.id,
    version:   doc.version,
    entities:  [...new Set([doc.name, nameLower, ...nameTokens])],
    tags:      doc.tags ?? [],
    summary:   doc.content.slice(0, 500),
    content:   doc.content,
    source:    { type: 'skill', uuid: doc.id },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
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
  private readonly store:     Store<SkillDoc>;
  private readonly knowledge: KnowledgeIndex;

  constructor(store: Store<SkillDoc>, knowledge: KnowledgeIndex) {
    this.store     = store;
    this.knowledge = knowledge;
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
   * Used by the node filesystem watcher to seed `.md` files without clobbering edits.
   * Returns `true` if a new skill was imported.
   */
  async importIfAbsent(name: string, content: string): Promise<boolean> {
    const key = name.toLowerCase();
    if (this.skills.has(key)) return false;
    const now = new Date().toISOString();
    const doc: SkillDoc = {
      id:        crypto.randomUUID(),
      version:   Date.now().toString(),
      name,
      content,
      triggers:  [],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(doc.id, doc);
    this.commit(doc, true);
    return true;
  }

  clear(): void {
    this.skills.clear();
  }

  private bump(doc: SkillDoc): SkillDoc {
    return { ...doc, version: Date.now().toString(), updatedAt: new Date().toISOString() };
  }

  private commit(doc: SkillDoc, reindex: boolean): void {
    this.skills.set(doc.name.toLowerCase(), doc);
    if (reindex) void this.knowledge.index(skillToKnowledgeEntry(doc));
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
