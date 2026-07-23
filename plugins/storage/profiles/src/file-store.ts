import type { FileEvent, FileFilter, FileHandle, FileStore, MimeType, Principal, Routed } from '@matatbread/matbot-plugin-api';

/** A partition's file store paired with the principal that owns it (`undefined` = base/global). */
export interface FileSource {
  origin: Principal | undefined;
  store:  FileStore;
}

/**
 * Merge every partition's `fileStore.watch()` into one stream, stamping each event with its origin
 * partition — the cross-partition firehose feed a frontend filters per connection. A fair round-robin
 * race: each source keeps one in-flight `next()`; the winner is yielded and re-armed, a finished source
 * drops out, and `signal` abort ends every underlying watch (their own `finally` closes the fs.watch).
 * Partitions are captured at subscribe time, so a profile created *after* this starts isn't watched until
 * the stream is re-subscribed (a frontend reload) — acceptable for a rare event on a long-lived stream.
 */
export async function* mergeRoutedFiles(sources: FileSource[], signal?: AbortSignal): AsyncIterable<Routed<FileEvent>> {
  interface Entry { origin: Principal | undefined; it: AsyncIterator<FileEvent>; }
  const entries: Entry[] = sources.map(s => ({ origin: s.origin, it: s.store.watch(signal)[Symbol.asyncIterator]() }));
  const pending = new Map<Entry, Promise<{ e: Entry; r: IteratorResult<FileEvent> }>>();
  const arm = (e: Entry): void => { pending.set(e, e.it.next().then(r => ({ e, r }))); };
  for (const e of entries) arm(e);
  try {
    while (pending.size > 0) {
      if (signal?.aborted) break;
      const { e, r } = await Promise.race(pending.values());
      if (r.done) { pending.delete(e); continue; }
      yield e.origin !== undefined ? { value: r.value, origin: e.origin } : { value: r.value };
      arm(e);
    }
  } finally {
    for (const e of entries) void e.it.return?.();
  }
}

/**
 * A {@link FileStore} that routes every op to a per-principal partition's file store, mirroring how
 * {@link ProfilesStorageBackend} routes `createStore`. Unlike document stores — which partition
 * per-namespace — files are ONE isolation axis (the pseudo-namespace `files`): the whole file area
 * moves together. Two reasons force this coarser grain:
 *   - `get(id)`/`delete(id)` carry no namespace, so a per-namespace route can't be resolved for them;
 *   - in the filesystem file store a file's namespace is a metadata *filter*, not a directory, so a
 *     namespace was never a partition boundary to begin with.
 * A profile that isolates `files` keeps its area under `profiles/<id>/files`; the default/unknown
 * principal and any profile that doesn't isolate it read the base area — byte-identical to the plain
 * filesystem backend, so existing files are untouched and visible.
 *
 * `pick()` resolves the current-principal file store per call via the backend's ambient router, so a
 * captured `ProfilesFileStore` reference always follows the principal in force (turn/request scope).
 */
export class ProfilesFileStore implements FileStore {
  private readonly pick: () => FileStore;
  constructor(pick: () => FileStore) { this.pick = pick; }

  put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string; allowed?: boolean },
  ): Promise<FileHandle> {
    return this.pick().put(name, mimeType, data, meta);
  }

  get(id: string): Promise<FileHandle | null> {
    return this.pick().get(id);
  }

  getByName(name: string, namespace?: string): Promise<FileHandle | null> {
    return this.pick().getByName(name, namespace);
  }

  delete(id: string): Promise<void> {
    return this.pick().delete(id);
  }

  list(filter?: FileFilter): AsyncIterable<FileHandle> {
    return this.pick().list(filter);
  }

  putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle> {
    return this.pick().putTemp(name, mimeType, data);
  }

  watch(signal?: AbortSignal): AsyncIterable<FileEvent> {
    // Routes on the principal in force when watch() is called — one partition's stream. The
    // cross-partition firehose (a server watching ALL partitions, filtered per connection) is Task 2b;
    // until then a profile that isolates files gets no live file events, base watching is unchanged.
    return this.pick().watch(signal);
  }
}
