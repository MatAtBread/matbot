import { join } from 'node:path';
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
    this.fileStore = new FilesystemFileStore(join(dotData, 'files'));
  }

  static open(dotData: string): Promise<FilesystemStorageBackend> {
    return Promise.resolve(new FilesystemStorageBackend(dotData));
  }

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    return new FilesystemStore<T>(join(this.dotData, namespace));
  }
}
