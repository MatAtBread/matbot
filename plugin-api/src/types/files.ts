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
