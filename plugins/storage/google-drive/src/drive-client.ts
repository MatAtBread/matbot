import type { DriveAuth } from './drive-auth.js';

// Thin wrapper over the Google Drive v3 REST + upload endpoints. Every call carries the bearer token
// from DriveAuth; a 401 invalidates the token and retries once (covers silent renewal of an expired
// token). Nothing here knows about matbot stores — it speaks folders, files, and bytes.

const API    = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id:        string;
  name:      string;
  mimeType?: string;
}

function qEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class DriveClient {
  private readonly auth: DriveAuth;

  constructor(auth: DriveAuth) {
    this.auth = auth;
  }

  private async fetch(url: string, init: RequestInit, retryOn401 = true): Promise<Response> {
    const token = await this.auth.token();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401 && retryOn401) {
      this.auth.invalidate();
      return this.fetch(url, init, false);
    }
    return res;
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Drive ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }
    return res.json() as Promise<T>;
  }

  /** List children of a folder, optionally filtered to one exact name. Folders themselves excluded
   *  unless `foldersOnly`. Walks pagination so callers get the full set. */
  async list(parentId: string, opts?: { name?: string; foldersOnly?: boolean }): Promise<DriveFile[]> {
    const clauses = [`'${qEscape(parentId)}' in parents`, 'trashed=false'];
    if (opts?.name !== undefined)  clauses.push(`name='${qEscape(opts.name)}'`);
    if (opts?.foldersOnly)         clauses.push(`mimeType='${FOLDER_MIME}'`);
    const q = clauses.join(' and ');

    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        fields:   'nextPageToken,files(id,name,mimeType)',
        spaces:   'drive',
        pageSize: '1000',
      });
      if (pageToken !== undefined) params.set('pageToken', pageToken);
      const res  = await this.fetch(`${API}/files?${params.toString()}`, { method: 'GET' });
      const page = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(res);
      out.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return out;
  }

  /** Find a child folder by name, creating it if absent. `parentId` of 'root' targets Drive root. */
  async ensureFolder(name: string, parentId: string): Promise<string> {
    const existing = await this.list(parentId, { name, foldersOnly: true });
    if (existing[0] !== undefined) return existing[0].id;
    const res = await this.fetch(`${API}/files`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return (await this.json<DriveFile>(res)).id;
  }

  /** Resolve (creating as needed) a nested folder path under `rootParent` (default Drive root). */
  async ensureFolderPath(parts: string[], rootParent = 'root'): Promise<string> {
    let parent = rootParent;
    for (const part of parts) parent = await this.ensureFolder(part, parent);
    return parent;
  }

  async readText(fileId: string): Promise<string> {
    const res = await this.fetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' });
    if (!res.ok) throw new Error(`Google Drive read ${res.status} for ${fileId}`);
    return res.text();
  }

  async readBytes(fileId: string): Promise<Uint8Array> {
    const res = await this.fetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' });
    if (!res.ok) throw new Error(`Google Drive read ${res.status} for ${fileId}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Create a file with body, returning its id. */
  async createFile(name: string, parentId: string, body: Blob | string, mimeType: string): Promise<string> {
    const metadata = { name, parents: [parentId] };
    const { contentType, payload } = multipart(metadata, body, mimeType);
    const res = await this.fetch(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method:  'POST',
      headers: { 'content-type': contentType },
      body:    payload,
    });
    return (await this.json<DriveFile>(res)).id;
  }

  /** Overwrite an existing file's content in place (metadata unchanged). */
  async updateFile(fileId: string, body: Blob | string, mimeType: string): Promise<void> {
    const res = await this.fetch(`${UPLOAD}/${encodeURIComponent(fileId)}?uploadType=media`, {
      method:  'PATCH',
      headers: { 'content-type': mimeType },
      body,
    });
    await this.json<DriveFile>(res);
  }

  async deleteFile(fileId: string): Promise<void> {
    const res = await this.fetch(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    // 404 ⇒ already gone, which is the caller's desired end state.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Google Drive delete ${res.status} for ${fileId}`);
    }
  }
}

/** Build a `multipart/related` body (JSON metadata + media part) for Drive's multipart upload. */
function multipart(metadata: unknown, media: Blob | string, mediaType: string): { contentType: string; payload: Blob } {
  const boundary = `mb${crypto.randomUUID().replace(/-/g, '')}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mediaType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    payload:     new Blob([head, media, tail]),
  };
}
