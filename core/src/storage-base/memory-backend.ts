import type {
  StorageBackend, Store, FileStore, FileHandle, FileMetaData, FileFilter, MimeType,
} from '@matatbread/matbot-plugin-api';
import { MemoryStore } from './memory-store.js';

interface MemoryFile { meta: FileMetaData; chunks: Uint8Array[] }

/** A `FileStore` held in a `Map`. Ids follow the filesystem store: a named file's id IS its name, so a
 *  second put of that name replaces it; an anonymous one gets a fresh UUID. */
export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, MemoryFile>();

  async put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    opts?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of data) chunks.push(chunk);
    const id = name ?? crypto.randomUUID();
    const meta: FileMetaData = {
      id, name: id, mimeType,
      version:   crypto.randomUUID(),
      size:      chunks.reduce((n, c) => n + c.byteLength, 0),
      createdAt: this.files.get(id)?.meta.createdAt ?? new Date().toISOString(),
      ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
      ...(opts?.namespace !== undefined ? { namespace: opts.namespace } : {}),
      ...(opts?.allowed   !== undefined ? { allowed:   opts.allowed   } : {}),
    };
    const file = { meta, chunks };
    this.files.set(id, file);
    return handle(file);
  }

  async get(id: string): Promise<FileHandle | null> {
    const file = this.files.get(id);
    return file !== undefined ? handle(file) : null;
  }

  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    for (const file of this.files.values()) {
      if (file.meta.name === name && (namespace === undefined || file.meta.namespace === namespace)) return handle(file);
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    this.files.delete(id);
  }

  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    for (const file of [...this.files.values()]) {
      const m = file.meta;
      if (filter?.namespace     !== undefined && m.namespace !== filter.namespace)           continue;
      if (filter?.sessionId     !== undefined && m.sessionId !== filter.sessionId)           continue;
      if (filter?.mimeType      !== undefined && !m.mimeType.startsWith(filter.mimeType))    continue;
      if (filter?.createdAfter  !== undefined && m.createdAt <  filter.createdAfter)         continue;
      if (filter?.createdBefore !== undefined && m.createdAt >  filter.createdBefore)        continue;
      yield handle(file);
    }
  }

  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }
}

// The chunks captured at the read, so a handle keeps the bytes it was issued for across a later upsert.
function handle({ meta, chunks }: MemoryFile): FileHandle {
  return { ...meta, async *stream() { yield* chunks; } };
}

/**
 * A `StorageBackend` that persists nothing: every namespace a `MemoryStore`, files a `MemoryFileStore`.
 * For a machine that needs no medium at all — a test, a short-lived embedder, a host deciding its
 * storage later — so that core alone can stand a machine up.
 */
export class MemoryStorageBackend implements StorageBackend {
  private readonly stores = new Map<string, MemoryStore<{ id: string; version: string }>>();
  readonly fileStore = new MemoryFileStore();

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    let store = this.stores.get(namespace);
    if (store === undefined) this.stores.set(namespace, store = new MemoryStore());
    return store as unknown as Store<T>;
  }

  async namespaces(): Promise<string[]> {
    return [...this.stores].filter(([, store]) => store.size > 0).map(([ns]) => ns).sort();
  }
}
