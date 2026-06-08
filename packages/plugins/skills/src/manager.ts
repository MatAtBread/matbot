import type { Store, KnowledgeIndex, KnowledgeEntry } from '@matatbread/matbot-plugin-api';
import type { SkillDoc } from './types.js';

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
    for (const { doc } of items) {
      this.skills.set(doc.name.toLowerCase(), doc);
      void this.knowledge.index(skillToKnowledgeEntry(doc));
    }
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

  /** Create a new skill or update an existing one by name (case-insensitive). */
  async save(name: string, content: string): Promise<SkillDoc> {
    const now = new Date().toISOString();
    const key = name.toLowerCase();
    let doc = this.skills.get(key);

    if (doc === undefined) {
      const newDoc: SkillDoc = {
        id:        crypto.randomUUID(),
        version:   Date.now().toString(),
        name,
        content,
        contexts:  ['global'],
        createdAt: now,
        updatedAt: now,
      };
      await this.store.set(newDoc.id, newDoc);
      this.skills.set(key, newDoc);
      void this.knowledge.index(skillToKnowledgeEntry(newDoc));
      return newDoc;
    }

    for (;;) {
      const next: SkillDoc = { ...doc, content, updatedAt: now, version: Date.now().toString() };
      const r = await this.store.cas(doc.id, doc.version, next);
      if (r.ok) {
        this.skills.set(key, next);
        void this.knowledge.index(skillToKnowledgeEntry(next));
        return next;
      }
      const fresh = await this.store.get(doc.id);
      if (fresh === null) {
        await this.store.set(doc.id, next);
        this.skills.set(key, next);
        void this.knowledge.index(skillToKnowledgeEntry(next));
        return next;
      }
      doc = fresh;
    }
  }

  /** Delete a skill by name. Returns the removed doc, or `undefined` if none existed. */
  async delete(name: string): Promise<SkillDoc | undefined> {
    const key = name.toLowerCase();
    const doc = this.skills.get(key);
    if (doc === undefined) return undefined;
    await this.store.delete(doc.id, doc.version);
    this.skills.delete(key);
    return doc;
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
      contexts:  ['global'],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(doc.id, doc);
    this.skills.set(key, doc);
    void this.knowledge.index(skillToKnowledgeEntry(doc));
    return true;
  }

  clear(): void {
    this.skills.clear();
  }
}
