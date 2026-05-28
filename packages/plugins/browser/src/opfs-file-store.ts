import type { FileFilter, FileHandle, FileStore, MimeType } from '@matatbread/matbot-core';

interface OPFSMeta {
  id:         string;
  version:    string;
  name:       string;
  mimeType:   MimeType;
  size:       number;
  createdAt:  string;
  sessionId?: string;
  messageId?: string;
}

async function rootDir(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function filesDir(): Promise<FileSystemDirectoryHandle> {
  const root = await rootDir();
  return root.getDirectoryHandle('matbot-files', { create: true });
}

function makeHandle(meta: OPFSMeta, dir: FileSystemDirectoryHandle): FileHandle {
  return {
    ...meta,
    async *stream(signal?: AbortSignal): AsyncIterable<Uint8Array> {
      const fh   = await dir.getFileHandle(`${meta.id}.data`);
      const file = await fh.getFile();
      const rs   = file.stream();
      const reader = rs.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || signal?.aborted) break;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/**
 * `FileStore` backed by the Origin Private File System (OPFS).
 * Requires a browser environment with `navigator.storage.getDirectory()`.
 */
export class OPFSFileStore implements FileStore {
  async put(
    name:     string,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string },
  ): Promise<FileHandle> {
    const dir  = await filesDir();
    const id   = crypto.randomUUID();

    // Write data file
    const dataFh  = await dir.getFileHandle(`${id}.data`, { create: true });
    const writable = await dataFh.createWritable();
    let size = 0;
    for await (const chunk of data) {
      // Copy into a fresh Uint8Array<ArrayBuffer> — OPFS writable requires ArrayBuffer-backed views
      const safe = new Uint8Array(chunk.byteLength);
      safe.set(chunk);
      await writable.write(safe);
      size += chunk.byteLength;
    }
    await writable.close();

    // Write metadata
    const fileMeta: OPFSMeta = {
      id,
      version:   crypto.randomUUID(),
      name,
      mimeType,
      size,
      createdAt: new Date().toISOString(),
      ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta?.messageId ? { messageId: meta.messageId } : {}),
    };
    const metaFh  = await dir.getFileHandle(`${id}.meta.json`, { create: true });
    const metaW   = await metaFh.createWritable();
    await metaW.write(JSON.stringify(fileMeta));
    await metaW.close();

    return makeHandle(fileMeta, dir);
  }

  async get(id: string): Promise<FileHandle | null> {
    try {
      const dir    = await filesDir();
      const metaFh = await dir.getFileHandle(`${id}.meta.json`);
      const file   = await metaFh.getFile();
      const meta   = JSON.parse(await file.text()) as OPFSMeta;
      return makeHandle(meta, dir);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    const dir = await filesDir();
    await Promise.allSettled([
      dir.removeEntry(`${id}.data`),
      dir.removeEntry(`${id}.meta.json`),
    ]);
  }

  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    const dir = await filesDir();
    // TypeScript DOM lib doesn't expose the async iterator methods on
    // FileSystemDirectoryHandle yet; cast to use the runtime-available protocol.
    type IterableDir = AsyncIterable<FileSystemHandle>;
    for await (const handle of dir as unknown as IterableDir) {
      const name = handle.name;
      if (!name.endsWith('.meta.json')) continue;
      const id  = name.slice(0, -'.meta.json'.length);
      const fh  = await this.get(id);
      if (!fh) continue;
      if (filter?.sessionId && fh.sessionId !== filter.sessionId) continue;
      if (filter?.mimeType  && !fh.mimeType.startsWith(filter.mimeType)) continue;
      if (filter?.createdAfter  && fh.createdAt < filter.createdAfter)  continue;
      if (filter?.createdBefore && fh.createdAt > filter.createdBefore) continue;
      yield fh;
    }
  }

  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }
}
