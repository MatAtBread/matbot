import type { ISODate, MimeType } from './primitives.js';

// ── Files ─────────────────────────────────────────────────────────────────────

export interface FileMetaData {
  id:          string;
  version:     string;
  name:        string;
  mimeType:    MimeType;
  size:        number;
  createdAt:   ISODate;
  sessionId?:  string;
  messageId?:  string;
  namespace?:  string;
  /** Whether this file may be served at a public URL. Default-deny: absent ⇒ not servable. The
   *  flag rides in the file's own persisted metadata (no separate allow-list), so the same read that
   *  resolves a request also gates it. Producers opt in per put (the workspace tool sets it true). */
  allowed?:    boolean;
}

export interface FileHandle extends FileMetaData {
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface FileFilter {
  sessionId?:     string;
  mimeType?:      string;
  namespace?:     string;
  createdAfter?:  ISODate;
  createdBefore?: ISODate;
}

/**
 * Where user-supplied session media lives — the bytes a person attached to a message, resolved back
 * onto the wire by the runner for as long as they stay inside the residency budget.
 *
 * Deliberately an ALIAS of {@link FileStore} rather than an interface of its own: `FileMetaData`
 * already carries `sessionId`/`messageId`/`namespace`/`allowed` and `FileFilter` already filters on
 * `sessionId`, so session-scoped lifetime, per-message attribution and a servable flag are in the
 * shape already. The consequence is the point — every existing FileStore (filesystem, SQLite, OPFS,
 * Drive) is a candidate media store unchanged, so putting media on one medium and everything else on
 * another is a *registration*, not a port. Two implementations of one interface get an alias, never an
 * invented role name (cf. `SessionStore`).
 */
export type MediaStore = FileStore;

export interface FileStore {
  /** Store a file. When `name` is provided, upserts by (name + namespace); otherwise always creates a new entry. */
  put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean }
  ): Promise<FileHandle>;
  get(id: string): Promise<FileHandle | null>;
  getByName(name: string, namespace?: string): Promise<FileHandle | null>;
  delete(id: string): Promise<void>;
  list(filter?: FileFilter): AsyncIterable<FileHandle>;
  putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle>;
}
