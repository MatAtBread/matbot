export interface SkillDoc {
  id:           string;
  version:      string;
  name:         string;
  content:      string;
  tags?:        string[];
  toolBinding?: string;
  /**
   * A one-line summary injected into the always-on skills catalogue in the system prompt, so the
   * model knows the skill exists and can reach for it (e.g. "Load before any data-source skill for
   * questions about traffic, page views, referrers, revenue…"). This is skill advertisement, not a
   * condition — the firing of skills on conditions is the triggers subsystem's concern, not skills'.
   */
  catalogSummary?: string;
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
