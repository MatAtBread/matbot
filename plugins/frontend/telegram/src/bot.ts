export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/** One rendition of a photo. Telegram sends several sizes; the last is the largest. */
export interface TelegramPhotoSize {
  file_id:        string;
  file_unique_id: string;
  width:          number;
  height:         number;
  file_size?:     number;
}

/** The shape shared by every non-photo attachment Telegram sends. `mime_type` is absent often enough
 *  (a voice note, an odd client) that the caller must have a fallback rather than trust it. */
export interface TelegramFile {
  file_id:        string;
  file_unique_id: string;
  file_name?:     string;
  mime_type?:     string;
  file_size?:     number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
  /** Prose that came WITH an attachment. Telegram puts it here instead of `text`, so a message with a
   *  photo and a question has an empty `text` — reading only `text` loses the question. */
  caption?:   string;
  photo?:     TelegramPhotoSize[];
  document?:  TelegramFile;
  audio?:     TelegramFile;
  voice?:     TelegramFile;
  video?:     TelegramFile;
}

const API = 'https://api.telegram.org';

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
): Promise<void> {
  for (const chunk of splitText(text)) {
    const res = await fetch(`${API}/bot${botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sendMessage failed: ${res.status} ${body}`);
    }
  }
}

export async function sendChatAction(
  botToken: string,
  chatId: number,
  action = 'typing',
): Promise<void> {
  await fetch(`${API}/bot${botToken}/sendChatAction`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, action }),
  });
}

export async function getUpdates(
  botToken: string,
  offset: number,
  timeout: number,
  signal: AbortSignal,
): Promise<TelegramUpdate[]> {
  const url =
    `${API}/bot${botToken}/getUpdates` +
    `?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22%5D`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`getUpdates failed: ${res.status} ${body}`);
  }
  const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
  if (!data.ok) throw new Error('Telegram getUpdates returned ok=false');
  return data.result;
}

// Telegram limits messages to 4096 UTF-16 code units.
function *splitText(text: string, max = 4096): Iterable<string> {
  if (text.length <= max) {
    yield text;
    return;
  }
  let i = 0;
  while(i < text.length) {
    const boundaries = [
      text.lastIndexOf(' ', i + max) + 1,
      text.lastIndexOf('\n', i + max) + 1,
      text.lastIndexOf('\t', i + max) + 1
    ].filter(v => v > 0 && v < max);
    const end = boundaries.length ? Math.max(...boundaries) : i + max;
    yield text.slice(i, end);
    i = end;
  }
}

/**
 * Fetch an attachment's bytes. Telegram is a two-step download — `getFile` trades a `file_id` for a
 * short-lived `file_path`, which is then fetched off a different host prefix (`/file/bot<token>/…`).
 * Returns null rather than throwing: one unreadable attachment must not lose the message it came with.
 */
export async function downloadFile(
  botToken: string,
  fileId:   string,
  signal?:  AbortSignal,
): Promise<{ bytes: Uint8Array; path: string } | null> {
  const meta = await fetch(`${API}/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, { ...(signal ? { signal } : {}) });
  if (!meta.ok) return null;
  const data = await meta.json() as { ok: boolean; result?: { file_path?: string } };
  const filePath = data.ok ? data.result?.file_path : undefined;
  if (filePath === undefined) return null;

  const res = await fetch(`${API}/file/bot${botToken}/${filePath}`, { ...(signal ? { signal } : {}) });
  if (!res.ok) return null;
  return { bytes: new Uint8Array(await res.arrayBuffer()), path: filePath };
}
