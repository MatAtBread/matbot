import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendFile } from '../../../plugins/frontend/telegram/src/bot.js';

// The outbound half of the same boundary. A `file` pipeline event is a durable HANDLE, not bytes on the
// wire, so rendering one means pulling it and uploading it — and Telegram's upload API is method-per-kind
// (`sendPhoto`/`sendAudio`/`sendVideo`/`sendDocument`), so which method a file goes out on is a real
// decision that a stub can pin. What it cannot decide in advance is whether Telegram will ACCEPT it: a
// photo's width+height sum and a video's container are checked server-side, which is why a rejection
// retries as a document rather than losing the file.

const realFetch = globalThis.fetch;

interface Sent { method: string; fields: string[]; filename?: string; caption?: string }

/** Records each upload; `reject` names the methods that answer 400 (as Telegram does for a bad photo). */
function stubUploads(reject: string[] = []): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const form   = init?.body as FormData;
    const file   = [...form.keys()].map(k => form.get(k)).find(v => v instanceof File);
    sent.push({
      method,
      fields: [...form.keys()],
      ...(file ? { filename: file.name } : {}),
      ...(form.has('caption') ? { caption: String(form.get('caption')) } : {}),
    });
    return reject.includes(method)
      ? new Response('{"ok":false,"description":"PHOTO_INVALID_DIMENSIONS"}', { status: 400 })
      : new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  return sent;
}

const bytes = new Uint8Array([1, 2, 3]);

test('each kind goes out on the method that renders it', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const sent = stubUploads();
  await sendFile('T', 7, { name: 'chart.png', mimeType: 'image/png',       bytes });
  await sendFile('T', 7, { name: 'note.ogg',  mimeType: 'audio/ogg',       bytes });
  await sendFile('T', 7, { name: 'clip.mp4',  mimeType: 'video/mp4',       bytes });
  await sendFile('T', 7, { name: 'report.pdf', mimeType: 'application/pdf', bytes });

  assert.deepEqual(sent.map(s => s.method), ['sendPhoto', 'sendAudio', 'sendVideo', 'sendDocument']);
  assert.deepEqual(sent.map(s => s.fields.at(-1)), ['photo', 'audio', 'video', 'document']);
  assert.deepEqual(sent.map(s => s.filename), ['chart.png', 'note.ogg', 'clip.mp4', 'report.pdf']);
});

test('an image too large for sendPhoto goes as a document without a round trip', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const sent = stubUploads();
  // 10MB is Telegram's photo cap; a bigger image is a document by construction, not after a rejection.
  await sendFile('T', 7, { name: 'huge.png', mimeType: 'image/png', bytes: new Uint8Array(11 * 1024 * 1024) });
  assert.deepEqual(sent.map(s => s.method), ['sendDocument']);
});

test('a rejected photo retries as a document — a file that arrives beats one that renders inline', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const sent = stubUploads(['sendPhoto']);
  await sendFile('T', 7, { name: 'wide.png', mimeType: 'image/png', bytes }, 'wide.png');
  assert.deepEqual(sent.map(s => s.method), ['sendPhoto', 'sendDocument']);
  assert.deepEqual(sent.map(s => s.caption), ['wide.png', 'wide.png'], 'the caption survives the retry');
});

test('a rejected document throws, naming both failures', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubUploads(['sendPhoto', 'sendDocument']);
  await assert.rejects(
    () => sendFile('T', 7, { name: 'wide.png', mimeType: 'image/png', bytes }),
    e => /sendPhoto failed.*sendDocument failed/s.test((e as Error).message),
  );
});

test('a caption is capped where Telegram caps it, rather than erroring the upload', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const sent = stubUploads();
  await sendFile('T', 7, { name: 'a.pdf', mimeType: 'application/pdf', bytes }, 'x'.repeat(2000));
  assert.equal(sent[0]!.caption!.length, 1024);
});
