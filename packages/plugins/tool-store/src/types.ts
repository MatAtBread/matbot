/**
 * The definition of a store managed by this plugin — its own persisted record, kept in the
 * plugin's meta store. One {@link StoreDef} governs one `Store<StoreRecord>` namespace and the
 * generated `<namespace>_action` tool over it. A def exists exactly when a tool is exposed for
 * that store; the def's `id` IS the managed namespace, so a def and its store share a name.
 */
export interface StoreDef {
  id:          string;
  version:     string;
  /** The namespace of the governed `Store<StoreRecord>`. Equal to `id`. */
  namespace:   string;
  /** Plain-English description of what the store holds. Shown in the generated tool's description. */
  description: string;
  /** The document shape as a flattened TypeScript type/interface (a string). Surfaced verbatim
   *  to the model in the generated tool's description so it knows what the store holds. Advisory
   *  for now — not yet enforced at write time.
   *
   *  TypeScript (rather than JSON Schema) is deliberate, and load-bearing for where this is headed:
   *    - LLMs author and read TS types far more reliably than JSON Schema.
   *    - It can be fed to a type-checker for real write-time validation (typia via its CLI, TypeBox).
   *    - It can be compiled to SQL column definitions for a relational backend.
   *    - JSON instances matching it can be handed straight to a NoSQL store (e.g. Elasticsearch).
   *  We may implement some or all of these later; the string is kept as canonical TS so they stay open. */
  shape:       string;
  createdAt:   string;
  updatedAt:   string;
}

/** A document held in a managed store. Beyond the required `id`/`version` (the `Store` contract),
 *  fields are open and described by the def's `shape`. */
export interface StoreRecord {
  id:      string;
  version: string;
  [key: string]: unknown;
}
