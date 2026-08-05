// ── Knowledge index ───────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id:           string;
  version:      string;
  entities:     string[];
  tags:         string[];
  summary:      string;
  content:      string;
  contentHash?: string;
  source:       { type: string; uuid: string };
  confidence?:  number;
  createdAt:    string;
  updatedAt:    string;
}

export interface KnowledgeIndex {
  index(entry: KnowledgeEntry): Promise<void>;
  /** Remove the entry with this id, if present (idempotent — removing an absent id is a no-op). The
   *  id is the index's sole primary key (`index` replaces by it), so retraction is by id alone; the
   *  index never inspects an entry's opaque `source`. The party that indexed an entry owns retracting
   *  it — e.g. a skill manager retracts a hidden/deleted skill rather than the index policing tenants. */
  remove(id: string): Promise<void>;
  search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]>;
  /** Enumerate all indexed entries. When present, register('KnowledgeIndex', …) drains these into the incoming backend. */
  entries?(): Iterable<KnowledgeEntry>;
}
