export type TriggerPhase = 'agent' | 'user' | 'system';

/**
 * A single trigger embedded in a skill. `id` is the stable identity (a UUID minted on write if
 * absent and preserved across updates) — never the text, never the array position — so a client
 * can address one trigger reliably across separate operations (telegram edit, HTTP form POST).
 */
export interface SkillTrigger {
  id?:     string;
  phase:   TriggerPhase;
  trigger: string;
}

export interface SkillDoc {
  id:           string;
  version:      string;
  name:         string;
  content:      string;
  triggers?:    SkillTrigger[];
  tags?:        string[];
  toolBinding?: string;
  createdAt:    string;
  updatedAt:    string;
  /**
   * Cached LLM analysis of `content`, valid only while `contentHash` matches the current content.
   * Generating it costs a `singleTurn` call, so it is persisted here and regenerated only when the
   * content changes — `init()` re-indexing on every restart then costs nothing. Derived metadata,
   * not authored: never set by a writer, only by the reindex path.
   */
  knowledge?: {
    contentHash: string;
    entities:    string[];
    tags:        string[];
    summary:     string;
  };
}
