import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import type { Store, FileStore, StorageBackend } from '@matatbread/matbot-plugin-api';
import { FilesystemFileStore } from '@matatbread/matbot-files-node';
import { FilesystemStore } from './store.js';

// Reproduces, as an explicit registered backend, the exact layout the node host already falls back to
// when no StorageBackend is registered: each namespace is a directory `<dotData>/<namespace>` of
// per-id JSON files (FilesystemStore), and files live under `<dotData>/files` (FilesystemFileStore).
// Installing the plugin therefore changes nothing about *where* data lives — its point is that the
// filesystem store becomes nameable, so you can assert it to override another backend instead of only
// reaching it implicitly by unregistering whatever is in force. Stores mkdir lazily, so open() opens
// nothing eagerly (cf. SQLite, which must create its db file).
export class FilesystemStorageBackend implements StorageBackend {
  readonly fileStore: FileStore;
  private readonly dotData: string;

  constructor(dotData: string) {
    this.dotData   = dotData;
    this.fileStore = new FilesystemFileStore(join(dotData, FILES_DIR));
  }

  static open(dotData: string): Promise<FilesystemStorageBackend> {
    return Promise.resolve(new FilesystemStorageBackend(dotData));
  }

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    return new FilesystemStore<T>(join(this.dotData, namespace));
  }

  /**
   * A directory under `<dotData>` is a namespace when it **directly** contains at least one document.
   * That is a content test rather than a name test on purpose: `.data` is a shared root, and anything
   * may put a directory there — a plugin's working state (`bash-cwd`), or another backend's root of
   * further partitions. Neither is nameable from here, and neither should be: guessing by name would
   * mean this backend carrying a list of other packages' directories, and a namespace that does not
   * exist would be traversed as empty while reporting success.
   *
   * `directly` is what excludes a nested partition root — its documents live one level further down,
   * so it holds no documents of its own and is not a namespace of this backend, which is exactly the
   * truth regardless of who created it.
   *
   * The pattern matches FilesystemStore's own: an id-named `.json`, excluding writeAtomic's `.tmp`
   * scratch files. An empty store directory is therefore absent from the result, which is what a
   * caller about to read it wants to know.
   */
  async namespaces(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.dotData, { withFileTypes: true });
    } catch {
      return [];                                             // no .data yet — nothing is stored
    }

    const found = await Promise.all(
      entries
        .filter(e => e.isDirectory() && e.name !== FILES_DIR)
        .map(async e => {
          try {
            const names = await fs.readdir(join(this.dotData, e.name));
            return names.some(n => DOC_FILE.test(n)) ? e.name : undefined;
          } catch { return undefined; }                      // vanished or unreadable between calls
        }),
    );
    return found.filter((n): n is string => n !== undefined).sort();
  }
}

// This backend's own blob area — the one directory it can exclude on its own authority, and the one
// that needs excluding by name rather than by content, since a stored file may simply be called
// `x.json`. Files are enumerated through `fileStore.list()`, never as a namespace.
const FILES_DIR = 'files';

const DOC_FILE = /^[\w.%-]+\.json$/;
