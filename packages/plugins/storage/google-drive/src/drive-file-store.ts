import type { FileEvent, FileFilter, FileHandle, FileStore, MimeType } from '@matatbread/matbot-core';
import type { DriveClient } from './drive-client.js';

const DATA_SUFFIX = '.data';
const META_SUFFIX = '.meta.json';
const JSON_MIME   = 'application/json';

interface DriveFileMeta {
  id:         string;
  version:    string;
  name:       string;
  mimeType:   MimeType;
  size:       number;
  createdAt:  string;
  sessionId?: string;
  messageId?: string;
  namespace?: string;
  allowed?:   boolean;
}

interface Slot {
  meta:       DriveFileMeta;
  dataFileId: string;
  metaFileId: string;
}

async function collect(data: AsyncIterable<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of data) { chunks.push(chunk); size += chunk.byteLength; }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * `FileStore` backed by a Google Drive folder: each blob is an `<id>.data` file paired with an
 * `<id>.meta.json` sidecar (the same shape as the OPFS browser store). Metadata is read into memory
 * once on first access so `list`/`get`/`getByName` don't re-walk Drive; blob bytes are fetched on
 * demand when a handle is streamed. Uploads buffer the full blob in memory before sending — adequate
 * for the chat-attachment sizes this serves, not for very large files.
 */
export class DriveFileStore implements FileStore {
  private readonly drive:    DriveClient;
  private readonly folderId: Promise<string>;
  private readonly slots = new Map<string, Slot>();
  private loaded?: Promise<void>;
  private chain:   Promise<unknown> = Promise.resolve();

  constructor(drive: DriveClient, folderId: Promise<string>) {
    this.drive    = drive;
    this.folderId = folderId;
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded !== undefined) return this.loaded;
    this.loaded = (async () => {
      const folder = await this.folderId;
      const files  = await this.drive.list(folder);
      const data   = new Map<string, string>();   // id → dataFileId
      const metas  = new Map<string, string>();    // id → metaFileId
      for (const f of files) {
        if (f.name.endsWith(META_SUFFIX))      metas.set(f.name.slice(0, -META_SUFFIX.length), f.id);
        else if (f.name.endsWith(DATA_SUFFIX)) data.set(f.name.slice(0, -DATA_SUFFIX.length), f.id);
      }
      await Promise.all([...metas].map(async ([id, metaFileId]) => {
        const dataFileId = data.get(id);
        if (dataFileId === undefined) return;   // orphaned meta — skip
        const meta = JSON.parse(await this.drive.readText(metaFileId)) as DriveFileMeta;
        this.slots.set(id, { meta, dataFileId, metaFileId });
      }));
    })();
    return this.loaded;
  }

  private lock<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private makeHandle(meta: DriveFileMeta): FileHandle {
    const drive = this.drive;
    const slots = this.slots;
    return {
      ...meta,
      async *stream(signal?: AbortSignal): AsyncIterable<Uint8Array> {
        const slot = slots.get(meta.id);
        if (slot === undefined || signal?.aborted) return;
        const bytes = await drive.readBytes(slot.dataFileId);
        if (signal?.aborted) return;
        yield bytes;
      },
    };
  }

  async put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    await this.ensureLoaded();
    const bytes = await collect(data);
    return this.lock(async () => {
      const folder = await this.folderId;

      // Upsert by name (+ namespace) when a name is given, matching the OPFS store's semantics.
      const existing = name !== undefined ? this.findByName(name, meta?.namespace) : undefined;

      const id        = existing?.meta.id ?? crypto.randomUUID();
      const createdAt = existing?.meta.createdAt ?? new Date().toISOString();
      const fileMeta: DriveFileMeta = {
        id,
        version:   crypto.randomUUID(),
        name:      name ?? id,
        mimeType,
        size:      bytes.byteLength,
        createdAt,
        ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
        ...(meta?.messageId !== undefined ? { messageId: meta.messageId } : {}),
        ...(meta?.namespace !== undefined ? { namespace: meta.namespace } : {}),
        ...(meta?.allowed   !== undefined ? { allowed:   meta.allowed   } : {}),
      };

      const dataBody = new Blob([bytes], { type: mimeType });
      const metaBody = JSON.stringify(fileMeta);

      let dataFileId: string;
      let metaFileId: string;
      if (existing !== undefined) {
        await this.drive.updateFile(existing.dataFileId, dataBody, mimeType);
        await this.drive.updateFile(existing.metaFileId, metaBody, JSON_MIME);
        dataFileId = existing.dataFileId;
        metaFileId = existing.metaFileId;
      } else {
        dataFileId = await this.drive.createFile(`${id}${DATA_SUFFIX}`, folder, dataBody, mimeType);
        metaFileId = await this.drive.createFile(`${id}${META_SUFFIX}`, folder, metaBody, JSON_MIME);
      }
      this.slots.set(id, { meta: fileMeta, dataFileId, metaFileId });
      return this.makeHandle(fileMeta);
    });
  }

  async get(id: string): Promise<FileHandle | null> {
    await this.ensureLoaded();
    const slot = this.slots.get(id);
    return slot !== undefined ? this.makeHandle(slot.meta) : null;
  }

  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    await this.ensureLoaded();
    const slot = this.findByName(name, namespace);
    return slot !== undefined ? this.makeHandle(slot.meta) : null;
  }

  private findByName(name: string, namespace?: string): Slot | undefined {
    for (const slot of this.slots.values()) {
      if (slot.meta.name === name && (namespace === undefined || slot.meta.namespace === namespace)) return slot;
    }
    return undefined;
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    await this.lock(async () => {
      const slot = this.slots.get(id);
      if (slot === undefined) return;
      await Promise.allSettled([
        this.drive.deleteFile(slot.dataFileId),
        this.drive.deleteFile(slot.metaFileId),
      ]);
      this.slots.delete(id);
    });
  }

  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    await this.ensureLoaded();
    for (const slot of this.slots.values()) {
      const m = slot.meta;
      if (filter?.namespace     && m.namespace !== filter.namespace)            continue;
      if (filter?.sessionId     && m.sessionId !== filter.sessionId)            continue;
      if (filter?.mimeType      && !m.mimeType.startsWith(filter.mimeType))     continue;
      if (filter?.createdAfter  && m.createdAt < filter.createdAfter)           continue;
      if (filter?.createdBefore && m.createdAt > filter.createdBefore)          continue;
      yield this.makeHandle(m);
    }
  }

  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }

  // Drive has no cheap push change-feed; watch() yields nothing and resolves when the signal fires
  // (same as the OPFS store).
  async *watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    if (signal === undefined || signal.aborted) return;
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); });
  }
}
