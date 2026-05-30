import { DatabaseSync } from 'node:sqlite';
import type { FileStore, FileHandle, FileMetaData, FileEvent, FileFilter, MimeType } from '@matatbread/matbot-plugin-api';

const file_table_name = 'file_meta';

export class SQLiteFileStore implements FileStore {
  private readonly db:       DatabaseSync;
  private readonly watchers = new Set<(event: FileEvent) => void>();

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS ${file_table_name} (
      id          TEXT    PRIMARY KEY NOT NULL,
      name        TEXT    NOT NULL,
      mime_type   TEXT    NOT NULL,
      size        INTEGER NOT NULL,
      created_at  TEXT    NOT NULL,
      namespace   TEXT,
      session_id  TEXT,
      message_id  TEXT,
      data        BLOB    NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${file_table_name}_name      ON ${file_table_name} (name)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${file_table_name}_namespace ON ${file_table_name} (namespace)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${file_table_name}_session   ON ${file_table_name} (session_id)`);
  }

  async put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    opts?:    { sessionId?: string; messageId?: string; namespace?: string },
  ): Promise<FileHandle> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of data) chunks.push(chunk);
    const blob = Buffer.concat(chunks);
    const size = blob.length;
    const id   = name ?? crypto.randomUUID();
    const now  = new Date().toISOString();

    let createdAt: string;
    let prevMeta:  MetaRow | undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      prevMeta  = this.db.prepare(META_SELECT + ` WHERE id = ?`).get(id) as unknown as MetaRow | undefined;
      createdAt = prevMeta?.created_at ?? now;
      this.db.prepare(`
        INSERT OR REPLACE INTO ${file_table_name} (id, name, mime_type, size, created_at, namespace, session_id, message_id, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, id, mimeType, size, createdAt,
             opts?.namespace ?? null, opts?.sessionId ?? null, opts?.messageId ?? null, blob);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    const nextRow: MetaRow = {
      id, name: id, mime_type: mimeType, size, created_at: createdAt,
      namespace:  opts?.namespace  ?? null,
      session_id: opts?.sessionId  ?? null,
      message_id: opts?.messageId  ?? null,
    };
    const handle = this.buildHandle(nextRow);
    this.emit(buildFileEvent(handle, prevMeta !== undefined ? metaFromRow(prevMeta) : undefined));
    return handle;
  }

  async get(id: string): Promise<FileHandle | null> {
    const row = this.db.prepare(META_SELECT + ` WHERE id = ?`).get(id) as unknown as MetaRow | undefined;
    return row !== undefined ? this.buildHandle(row) : null;
  }

  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    const row = namespace !== undefined
      ? this.db.prepare(META_SELECT + ` WHERE name = ? AND namespace = ?`).get(name, namespace) as unknown as MetaRow | undefined
      : this.db.prepare(META_SELECT + ` WHERE name = ?`).get(name) as unknown as MetaRow | undefined;
    return row !== undefined ? this.buildHandle(row) : null;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${file_table_name} WHERE id = ?`).run(id);
  }

  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    const rows = this.db.prepare(META_SELECT).all() as unknown as MetaRow[];
    for (const row of rows) {
      const h = this.buildHandle(row);
      if (filter?.namespace     !== undefined && h.namespace  !== filter.namespace)       continue;
      if (filter?.sessionId     !== undefined && h.sessionId  !== filter.sessionId)       continue;
      if (filter?.mimeType      !== undefined && !h.mimeType.startsWith(filter.mimeType)) continue;
      if (filter?.createdAfter  !== undefined && h.createdAt  <  filter.createdAfter)     continue;
      if (filter?.createdBefore !== undefined && h.createdAt  >  filter.createdBefore)    continue;
      yield h;
    }
  }

  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }

  async *watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    const queue: FileEvent[] = [];
    let notify: (() => void) | undefined;
    let done = false;

    const wake     = (): void => { const fn = notify; notify = undefined; fn?.(); };
    const listener = (event: FileEvent): void => { queue.push(event); wake(); };
    const onAbort  = (): void => { done = true; this.watchers.delete(listener); wake(); };

    this.watchers.add(listener);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      while (!done) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) break;
        await new Promise<void>(r => { notify = r; });
      }
    } finally {
      this.watchers.delete(listener);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private emit(event: FileEvent): void {
    for (const fn of this.watchers) fn(event);
  }

  private buildHandle(row: MetaRow): FileHandle {
    const db = this.db;
    const meta: FileMetaData = {
      id:        row.id,
      version:   row.size.toString(),
      name:      row.name,
      mimeType:  row.mime_type,
      size:      row.size,
      createdAt: row.created_at,
      ...(row.namespace  !== null ? { namespace:  row.namespace  } : {}),
      ...(row.session_id !== null ? { sessionId:  row.session_id } : {}),
      ...(row.message_id !== null ? { messageId:  row.message_id } : {}),
    };
    return {
      ...meta,
      stream(_signal?: AbortSignal): AsyncIterable<Uint8Array> {
        const id = row.id;
        return (async function*() {
          const dataRow = db.prepare(`SELECT data FROM ${file_table_name} WHERE id = ?`).get(id) as unknown as { data: Buffer } | undefined;
          if (dataRow !== undefined) yield dataRow.data;
        })();
      },
    };
  }
}

// Selects all metadata columns except the blob — data is fetched lazily in stream().
const META_SELECT = `SELECT id, name, mime_type, size, created_at, namespace, session_id, message_id FROM ${file_table_name}`;

const META_KEYS: ReadonlyArray<keyof FileMetaData> = [
  'id', 'version', 'name', 'mimeType', 'size', 'createdAt',
  'sessionId', 'messageId', 'namespace',
];

interface MetaRow {
  id:         string;
  name:       string;
  mime_type:  string;
  size:       number;
  created_at: string;
  namespace:  string | null;
  session_id: string | null;
  message_id: string | null;
}

function metaFromRow(row: MetaRow): FileMetaData {
  return {
    id:        row.id,
    version:   row.size.toString(),
    name:      row.name,
    mimeType:  row.mime_type,
    size:      row.size,
    createdAt: row.created_at,
    ...(row.namespace  !== null ? { namespace:  row.namespace  } : {}),
    ...(row.session_id !== null ? { sessionId:  row.session_id } : {}),
    ...(row.message_id !== null ? { messageId:  row.message_id } : {}),
  };
}

function buildFileEvent(handle: FileHandle, prev: FileMetaData | undefined): FileEvent {
  const meta = metaFromRow({
    id:         handle.id,
    name:       handle.name,
    mime_type:  handle.mimeType,
    size:       handle.size,
    created_at: handle.createdAt,
    namespace:  handle.namespace  ?? null,
    session_id: handle.sessionId  ?? null,
    message_id: handle.messageId  ?? null,
  });
  const a = meta as unknown as Record<string, unknown>;
  const b = prev as unknown as Record<string, unknown> | undefined;
  const changed = b === undefined
    ? [...META_KEYS]
    : META_KEYS.filter(k => a[k] !== b[k]);
  return { ...meta, changed };
}
