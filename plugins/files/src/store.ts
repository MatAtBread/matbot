import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileEvent, FileFilter, FileHandle, FileMetaData, FileStore, MimeType } from '@matatbread/matbot-core';

// Only what the filesystem cannot derive: semantic metadata.
interface FileMeta {
  mimeType:   MimeType;
  sessionId?: string;
  messageId?: string;
  namespace?: string;
  allowed?:   boolean;
  // Set on new anonymous entries (UUID id, .data extension).
  // Absent on named entries — data path mirrors the id directly.
  dataFile?:  string;
  // Present only in legacy entries written before the named-file refactor.
  // Used to detect the legacy layout: data was at id + '.data'.
  id?:        string;
}

function resolveDataPath(dir: string, id: string, meta: FileMeta): string {
  if (meta.dataFile !== undefined) return path.join(dir, meta.dataFile); // new anonymous
  if (meta.id       !== undefined) return path.join(dir, id + '.data'); // legacy anonymous
  return path.join(dir, id);                                             // new named
}

function metaFilePath(dir: string, id: string): string {
  return path.join(dir, `${id}.meta.json`);
}

async function makeHandle(id: string, meta: FileMeta, dir: string): Promise<FileHandle> {
  const dp = resolveDataPath(dir, id, meta);
  const mp = metaFilePath(dir, id);
  const [ds, ms] = await Promise.all([stat(dp), stat(mp)]);
  const born = ms.birthtimeMs > 0 ? ms.birthtimeMs : ms.ctimeMs;
  const fileMetaData: FileMetaData = {
    id,
    name:      id,
    version:   ds.mtimeMs.toString(),
    size:      ds.size,
    createdAt: new Date(born).toISOString(),
    mimeType:  meta.mimeType,
    ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    ...(meta.messageId !== undefined ? { messageId: meta.messageId } : {}),
    ...(meta.namespace !== undefined ? { namespace: meta.namespace } : {}),
    ...(meta.allowed   !== undefined ? { allowed:   meta.allowed   } : {}),
  };
  return {
    ...fileMetaData,
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array> {
      return nodeStreamToAsyncIterable(dp, signal);
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

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async writeData(targetPath: string, data: AsyncIterable<Uint8Array>): Promise<void> {
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
    const fh = await open(tmpPath, 'w');
    try {
      for await (const chunk of data) {
        await fh.write(chunk);
      }
      await fh.close();
    } catch (err) {
      await fh.close().catch(() => {});
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
    await rename(tmpPath, targetPath);
  }

  private async getRawMeta(id: string): Promise<FileMeta | null> {
    try {
      return JSON.parse(await readFile(metaFilePath(this.dir, id), 'utf8')) as FileMeta;
    } catch {
      return null;
    }
  }

  async put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    opts?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    await this.ensureDir();
    const extras = {
      ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
      ...(opts?.namespace !== undefined ? { namespace: opts.namespace } : {}),
      ...(opts?.allowed   !== undefined ? { allowed:   opts.allowed   } : {}),
    };

    if (name !== undefined) {
      // Named files: id = name, disk layout mirrors the logical name.
      const dp = path.join(this.dir, name);
      await mkdir(path.dirname(dp), { recursive: true });
      await this.writeData(dp, data);
      const meta: FileMeta = { mimeType, ...extras };
      // writeFile on existing file preserves inode → birthtime survives upserts.
      await writeFile(metaFilePath(this.dir, name), JSON.stringify(meta));
      return makeHandle(name, meta, this.dir);
    }

    // Anonymous: UUID id, legacy .data extension.
    const id = crypto.randomUUID();
    await this.writeData(path.join(this.dir, id + '.data'), data);
    const meta: FileMeta = { mimeType, dataFile: id + '.data', ...extras };
    await writeFile(metaFilePath(this.dir, id), JSON.stringify(meta));
    return makeHandle(id, meta, this.dir);
  }

  async get(id: string): Promise<FileHandle | null> {
    const meta = await this.getRawMeta(id);
    if (!meta) return null;
    try {
      return await makeHandle(id, meta, this.dir);
    } catch {
      // Data file missing or unreadable.
      return null;
    }
  }

  async getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    // Direct O(1) lookup for named files (id === name).
    const direct = await this.get(name);
    if (direct !== null && (namespace === undefined || direct.namespace === namespace)) return direct;
    // Fall back to full scan for legacy UUID-based entries.
    for await (const handle of this.list(namespace !== undefined ? { namespace } : {})) {
      if (handle.name === name) return handle;
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    const meta = await this.getRawMeta(id);
    const dp = meta ? resolveDataPath(this.dir, id, meta) : path.join(this.dir, id + '.data');
    await Promise.all([
      rm(metaFilePath(this.dir, id), { force: true }),
      rm(dp,                          { force: true }),
    ]);
  }

  async *list(filter?: FileFilter): AsyncIterable<FileHandle> {
    await this.ensureDir();
    for await (const mfp of this.findMetaFiles(this.dir)) {
      const rel = path.relative(this.dir, mfp);
      const id  = rel.slice(0, -'.meta.json'.length);
      const fh  = await this.get(id);
      if (!fh) continue;
      if (filter?.namespace     && fh.namespace  !== filter.namespace)                   continue;
      if (filter?.sessionId     && fh.sessionId  !== filter.sessionId)                   continue;
      if (filter?.mimeType      && !fh.mimeType.startsWith(filter.mimeType))             continue;
      if (filter?.createdAfter  && fh.createdAt  <  filter.createdAfter)                 continue;
      if (filter?.createdBefore && fh.createdAt  >  filter.createdBefore)                continue;
      yield fh;
    }
  }

  private async *findMetaFiles(dir: string): AsyncIterable<string> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        yield* this.findMetaFiles(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.meta.json')) {
        yield path.join(dir, entry.name);
      }
    }
  }

  async putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.put(name, mimeType, data);
  }

  async *watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    // A per-subscriber bridge over the external `fs.watch` source — deliberately NOT the shared
    // `createBroadcaster` fan-out (that's for internally-emitted events like the sqlite store's). Each
    // subscriber owns its own fs.watch; the profiles backend merges one such stream per partition.
    // fs.watch throws ENOENT on a missing directory, so ensure it exists first — mirroring put()/list().
    // This bites when a registered StorageBackend is the boot backend: the host skips its own files-dir
    // mkdir, so nothing else has created the directory before the frontend starts watching it.
    await this.ensureDir();
    const queue:     FileEvent[]                             = [];
    const prevMeta   = new Map<string, FileMetaData>();
    const debounces  = new Map<string, ReturnType<typeof setTimeout>>();
    let   notify:    (() => void) | undefined;
    let   done       = false;

    const wake = (): void => { const fn = notify; notify = undefined; fn?.(); };

    const handleChange = async (id: string): Promise<void> => {
      const handle = await this.get(id);
      if (!handle) { prevMeta.delete(id); return; }
      queue.push(buildFileEvent(handle, prevMeta.get(id)));
      prevMeta.set(id, metaFromHandle(handle));
      wake();
    };

    const watcher = watch(this.dir, { recursive: true }, (_, filename) => {
      if (typeof filename !== 'string') return;
      if (filename.endsWith('.meta.json') || filename.endsWith('.tmp')) return;
      const id = filename.endsWith('.data') ? filename.slice(0, -'.data'.length) : filename;
      const t  = debounces.get(id);
      if (t !== undefined) clearTimeout(t);
      debounces.set(id, setTimeout(() => { debounces.delete(id); void handleChange(id); }, 50));
    });

    const onAbort = (): void => { done = true; watcher.close(); wake(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      while (!done) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) break;
        await new Promise<void>(r => { notify = r; });
      }
    } finally {
      watcher.close();
      signal?.removeEventListener('abort', onAbort);
      for (const t of debounces.values()) clearTimeout(t);
    }
  }
}

// ── FileEvent helpers ─────────────────────────────────────────────────────────

const META_KEYS: ReadonlyArray<keyof FileMetaData> = [
  'id', 'version', 'name', 'mimeType', 'size', 'createdAt',
  'sessionId', 'messageId', 'namespace', 'allowed',
];

function metaFromHandle(h: FileHandle): FileMetaData {
  return {
    id:        h.id,
    version:   h.version,
    name:      h.name,
    mimeType:  h.mimeType,
    size:      h.size,
    createdAt: h.createdAt,
    ...(h.sessionId !== undefined ? { sessionId: h.sessionId } : {}),
    ...(h.messageId !== undefined ? { messageId: h.messageId } : {}),
    ...(h.namespace !== undefined ? { namespace: h.namespace } : {}),
    ...(h.allowed   !== undefined ? { allowed:   h.allowed   } : {}),
  };
}

function buildFileEvent(handle: FileHandle, prev: FileMetaData | undefined): FileEvent {
  const meta = metaFromHandle(handle);
  const a    = meta as unknown as Record<string, unknown>;
  const b    = prev as unknown as Record<string, unknown> | undefined;
  const changed = b === undefined
    ? [...META_KEYS]
    : META_KEYS.filter(k => a[k] !== b[k]);
  return { ...meta, changed };
}
