export interface SkillDoc {
  id:           string;
  version:      string;
  name:         string;
  content:      string;
  tags?:        string[];
  toolBinding?: string;
  /**
   * Whether this skill is advertised in the always-on skills catalogue in the system prompt (so the
   * model knows it exists and can reach for it). This is skill *advertisement*, not a condition — the
   * firing of skills on conditions is the triggers subsystem's concern, not skills'. The advertised
   * text is `catalogSummary` if set, else the generated `knowledge.summary` (see the contributor).
   */
  catalogue?: boolean;
  /**
   * Optional hand-written one-line catalogue blurb. When `catalogue` is set this overrides the
   * generated `knowledge.summary` as the advertised text. Currently has no editing UI — the generated
   * summary fills the blank — but the field is here so authoring it later needs no schema change.
   */
  catalogSummary?: string;
  /**
   * Whether this skill is withheld from the model: retracted from the knowledge index (so
   * `contextual_search` / `find_fact` can't surface it) and excluded from the catalogue
   * advertisement. It stays fully manageable — list/load/use/metadata/save/delete all still operate
   * on it — so a skill that has been compiled into a tool (or otherwise superseded) can be retired
   * from the model's reach without being deleted, keeping its "source" for the compiler. Set/cleared
   * only by the explicit hide/unhide actions; never touched by `save`, so a content edit preserves it.
   */
  hidden?: boolean;
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
    /**
     * How the skill reads, as two independent 0–1 confidences (they need not sum to 1):
     * `procedural` (steps/workflows/input-process-output — a method to execute) vs `informational`
     * (reference/facts/narrative — material to read). The skill compiler gates on this (only a
     * primarily-procedural skill compiles to a tool); contextual_search uses it to favour
     * informational skills. Derived by the same analysis pass as the rest of this block.
     */
    classification: { procedural: number; informational: number };
  };
}
