import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { FileFilter, FileHandle, FileStore, MimeType } from '@matatbread/matbot-core';

interface FileMeta {
  id:          string;
  version:     string;
  name:        string;
  mimeType:    MimeType;
  size:        number;
  createdAt:   string;
  sessionId?:  string;
  messageId?:  string;
  namespace?:  string;
}

function makeHandle(meta: FileMeta, dataPath: string): FileHandle {
  return {
    ...meta,
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array> {
      return nodeStreamToAsyncIterable(dataPath, signal);
    },
  };
}

async function *nodeStreamToAsyncIterable(
  filePath: string,
  signal?:  AbortSignal,
): AsyncIterable<Uint8Array> {
  const rs = createReadStream(filePath);
  signal?.addEventListener('abort', () => rs.destroy(), { once: true });
  for await (const chunk of rs) {
    yield chunk as Uint8Array;
  }
}

export class FilesystemFileStore implements FileStore {
  private readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

  private metaPath(id: string): string { return path.join(this.dir, `${id}.meta.json`); }
  private dataPath(id: string): string { return path.join(this.dir, `${id}.data`); }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async writeData(id: string, data: AsyncIterable<Uint8Array>): Promise<number> {
    const tmpPath = `${this.dataPath(id)}.tmp`;
    const fh = await open(tmpPath, 'w');
    let size = 0;
    try {
      for await (const chunk of data) {
        await fh.write(chunk);
        size += chunk.byteLength;
      }
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.dataPath(id));
    return size;
  }

  async put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string },
  ): Promise<FileHandle> {
    await this.ensureDir();

    // Upsert when name is provided: find existing entry with matching name (+ namespace).
    if (name !== undefined) {
      const existing = await this.getByName(name, meta?.namespace);
      if (existing !== null) {
        const size = await this.writeData(existing.id, data);
        const fileMeta: FileMeta = {
          id:        existing.id,
          version:   crypto.randomUUID(),
          name,
          mimeType,
          size,
          createdAt: existing.createdAt,
          ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
          ...(meta?.messageId !== undefined ? { messageId: meta.messageId } : {}),
          ...(meta?.namespace !== undefined ? { namespace: meta.namespace } : {}),
        };
        await writeFile(this.metaPath(existing.id), JSON.stringify(fileMeta), 'utf8');
        return makeHandle(fileMeta, this.dataPath(existing.id));
      }
    }

    const id   = crypto.randomUUID();
    const size = await this.writeData(id, data);

    const fileMeta: FileMeta = {
      id,
      version:   crypto.randomUUID(),
      name:      name ?? id,
      mimeType,
      size,
      createdAt: new Date().toISOString(),
      ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
      ...(meta?.messageId !== undefined ? { messageId: meta.messageId } : {}),
      ...(meta?.namespace !== undefined ? { namespace: meta.namespace } : {}),
    };
    await writeFile(this.metaPath(id), JSON.stringify(fileMeta), 'utf8');

    return makeHandle(fileMeta, this.dataPath(id));
  }

  async get(id: string): Promise<FileHandle | null> {
    try {
      const raw  = await import('node:fs/promises').then(m => m.readFile(this.metaPath(id), 'utf8'));
      const meta = JSON.parse(raw) as FileMeta;
      return makeHandle(meta, this.dataPath(id));
    } catch {
      return null;
    }
  }

  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    for await (const handle of this.list(namespace !== undefined ? { namespace } : {})) {
      if (handle.name === name) return handle;
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    await Promise.all([
      rm(this.metaPath(id), { force: true }),
      rm(this.dataPath(id), { force: true }),
    ]);
  }

  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    await this.ensureDir();
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      const id  = entry.slice(0, -'.meta.json'.length);
      const fh  = await this.get(id);
      if (!fh) continue;
      if (filter?.namespace    && fh.namespace    !== filter.namespace)                    continue;
      if (filter?.sessionId    && fh.sessionId    !== filter.sessionId)                   continue;
      if (filter?.mimeType     && !fh.mimeType.startsWith(filter.mimeType))               continue;
      if (filter?.createdAfter  && fh.createdAt < filter.createdAfter)                    continue;
      if (filter?.createdBefore && fh.createdAt > filter.createdBefore)                   continue;
      yield fh;
    }
  }

  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }
}
