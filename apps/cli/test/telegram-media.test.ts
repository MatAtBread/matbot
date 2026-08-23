import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageContent } from '../../../plugins/frontend/telegram/src/plugin.js';
import type { TelegramMessage } from '../../../plugins/frontend/telegram/src/bot.js';

// Telegram is the case that proves the by-value submission boundary: bytes arrive WITH the message and
// there is no upload-in-advance leg, nor can there be. So this frontend fetches and types, and hands the
// runner inline arms — the rewrite to `file-ref`s is the runner's, not repeated here.
//
// The download is two requests (getFile → file_path, then a different host prefix), so a stub stands in
// for the network; what is under test is the mapping, which is where the mistakes live.

const realFetch = globalThis.fetch;

/** Answers Telegram's two-step download for the file ids in `bytes`; anything else 404s. */
function stubTelegram(bytes: Record<string, Uint8Array>): void {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    const getFile = /getFile\?file_id=([^&]+)/.exec(u);
    if (getFile) {
      const id = decodeURIComponent(getFile[1]!);
      return id in bytes
        ? new Response(JSON.stringify({ ok: true, result: { file_path: `photos/${id}.bin` } }), { status: 200 })
        : new Response(JSON.stringify({ ok: false }), { status: 200 });
    }
    const download = /\/file\/bot[^/]+\/photos\/(.+)\.bin$/.exec(u);
    if (download) {
      const b = bytes[decodeURIComponent(download[1]!)];
      return b ? new Response(b as unknown as BodyInit, { status: 200 }) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

const base = (over: Partial<TelegramMessage>): TelegramMessage =>
  ({ message_id: 1, chat: { id: 7, type: 'private' }, ...over });

const signal = new AbortController().signal;

test('a photo with a caption keeps both, at the largest rendition', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  // Telegram sends several sizes and the largest is last; picking a thumbnail is what makes vision
  // look bad, so the size choice is load-bearing rather than arbitrary.
  stubTelegram({ small: new Uint8Array([1]), large: new Uint8Array([9, 9, 9]) });

  const { content, failed } = await messageContent('tok', base({
    caption: 'what is this?',
    photo: [
      { file_id: 'small', file_unique_id: 's', width: 90,   height: 60 },
      { file_id: 'large', file_unique_id: 'l', width: 1280, height: 850 },
    ],
  }), signal);

  assert.deepEqual(failed, []);
  assert.equal(content.length, 2);
  // Caption, not `text` — a photo-with-a-question has an empty `text`, and reading only that lost the question.
  assert.deepEqual(content[0], { type: 'text', text: 'what is this?' });
  assert.equal(content[1]!.type, 'image');
  assert.equal((content[1] as { data: string }).data, btoa(String.fromCharCode(9, 9, 9)), 'the LARGEST rendition');
});

test('a document, a voice note and a video each map to the right arm', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubTelegram({ d: new Uint8Array([1]), v: new Uint8Array([2]), m: new Uint8Array([3]) });

  const { content } = await messageContent('tok', base({
    document: { file_id: 'd', file_unique_id: 'd', file_name: 'spec.pdf', mime_type: 'application/pdf' },
    voice:    { file_id: 'v', file_unique_id: 'v' },                       // no mime_type — the common case
    video:    { file_id: 'm', file_unique_id: 'm', mime_type: 'video/mp4' },
  }), signal);

  assert.deepEqual(content.map(c => [c.type, (c as { name?: string }).name]), [
    ['document', 'spec.pdf'],
    ['audio',    'voice.ogg'],   // fallback name AND mime: audio/ogg ⇒ the audio arm
    ['document', 'video.mp4'],   // no video arm exists; a document degrades per-provider rather than vanishing
  ]);
});

test('a download that fails is named, not silently dropped', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubTelegram({});   // getFile answers ok:false for everything

  const { content, failed } = await messageContent('tok', base({
    text:  'have a look',
    photo: [{ file_id: 'gone', file_unique_id: 'g', width: 10, height: 10 }],
  }), signal);

  // A model answering about a photo it never received gives a confidently wrong answer — worse than
  // being told the download failed. The prose still goes through; only the image is reported missing.
  assert.deepEqual(failed, ['photo.jpg']);
  assert.deepEqual(content, [{ type: 'text', text: 'have a look' }]);
});

test('a plain text message is unchanged by any of this', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubTelegram({});
  const { content, failed } = await messageContent('tok', base({ text: 'hello' }), signal);
  assert.deepEqual(failed, []);
  assert.deepEqual(content, [{ type: 'text', text: 'hello' }]);
});
