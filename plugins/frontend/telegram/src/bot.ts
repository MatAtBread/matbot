export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramUser { id: number; first_name?: string; username?: string }

/** A press of an inline-keyboard button. `data` is what the button was sent with (≤64 bytes). */
export interface TelegramCallbackQuery {
  id:       string;
  from:     TelegramUser;
  message?: { message_id: number; chat: { id: number } };
  data?:    string;
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
  from?: TelegramUser;
  text?: string;
  reply_to_message?: { message_id: number };
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

/** Resolves to the id of the last message sent, which is the one carrying `replyMarkup`. */
export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup?: object,
): Promise<number> {
  const chunks = [...splitText(text)];
  let messageId = 0;
  for (const [i, chunk] of chunks.entries()) {
    const last = i === chunks.length - 1;
    const res = await fetch(`${API}/bot${botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: chunk, ...(last && replyMarkup ? { reply_markup: replyMarkup } : {}) }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sendMessage failed: ${res.status} ${body}`);
    }
    // The message is delivered by now; an unreadable body must not report it as a failed send.
    const sent = await res.json().catch(() => undefined) as { result?: { message_id?: number } } | undefined;
    messageId = sent?.result?.message_id ?? 0;
  }
  return messageId;
}

/** Replace a message's text. Sent without `reply_markup`, which also removes its inline keyboard. */
export async function editMessageText(
  botToken: string, chatId: number, messageId: number, text: string,
): Promise<void> {
  const res = await fetch(`${API}/bot${botToken}/editMessageText`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, message_id: messageId, text: text.slice(0, 4096) }),
  });
  if (!res.ok) throw new Error(`editMessageText failed: ${res.status} ${await res.text()}`);
}

/** Every button press must be answered, or the client shows a spinner on the button until it gives up. */
export async function answerCallbackQuery(botToken: string, id: string, text?: string): Promise<void> {
  await fetch(`${API}/bot${botToken}/answerCallbackQuery`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ callback_query_id: id, ...(text !== undefined ? { text } : {}) }),
  });
}

/** What a bot may upload in one call. A larger file has to be linked, not sent. */
export const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;
/** Beyond this Telegram refuses `sendPhoto`, so an image goes as a document instead of failing. */
const PHOTO_LIMIT = 10 * 1024 * 1024;
/** Telegram truncates a caption at 1024 UTF-16 units and errors past it, unlike `text`. */
const CAPTION_LIMIT = 1024;

export interface OutgoingFile {
  name:     string;
  mimeType: string;
  bytes:    Uint8Array;
}

/** The method that renders this file best, and the form field it wants the bytes under. */
function methodFor(file: OutgoingFile): readonly [string, string] {
  const mime = file.mimeType;
  if (mime.startsWith('image/') && file.bytes.byteLength <= PHOTO_LIMIT) return ['sendPhoto', 'photo'] as const;
  if (mime.startsWith('audio/')) return ['sendAudio', 'audio'] as const;
  if (mime.startsWith('video/')) return ['sendVideo', 'video'] as const;
  return ['sendDocument', 'document'] as const;
}

async function postFile(
  botToken: string, chatId: number, method: string, field: string, file: OutgoingFile, caption?: string,
): Promise<string | null> {
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (caption) form.set('caption', caption.slice(0, CAPTION_LIMIT));
  form.set(field, new Blob([file.bytes as BlobPart], { type: file.mimeType }), file.name);
  const res = await fetch(`${API}/bot${botToken}/${method}`, { method: 'POST', body: form });
  return res.ok ? null : `${res.status} ${await res.text()}`;
}

/**
 * Upload a file to a chat, rendered by what it is: an image inline, audio as a playable clip, anything
 * else as a document.
 *
 * A rejected `sendPhoto`/`sendAudio`/`sendVideo` retries as a document, because the constraints those
 * methods add are ones nothing here can check in advance — a photo's width+height sum, a container
 * Telegram will not transcode — and a file that arrives is worth more than one that renders inline.
 */
export async function sendFile(
  botToken: string, chatId: number, file: OutgoingFile, caption?: string,
): Promise<void> {
  const [method, field] = methodFor(file);
  const err = await postFile(botToken, chatId, method, field, file, caption);
  if (err === null) return;
  if (method === 'sendDocument') throw new Error(`sendDocument failed: ${err}`);
  const docErr = await postFile(botToken, chatId, 'sendDocument', 'document', file, caption);
  if (docErr !== null) throw new Error(`${method} failed: ${err}; sendDocument failed: ${docErr}`);
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
    `?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`;
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
