import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier,
  isMediaRejectedError, MEDIA_NAMESPACE, MAX_MEDIA_BYTES_PER_FILE,
} from '@matatbread/matbot-core';
import type {
  Session, Store, MediaStore, FileHandle, FileFilter, ProviderAdapter, ProviderConfig,
  CompletionEvent, PipelineEvent, Principal, Message, MimeType, UserContent,
} from '@matatbread/matbot-core';
import { createAlsPrincipalCarrier } from '../src/principal-als.js';
import { createAlsUsageCarrier } from '../src/usage-als.js';

installPrincipalCarrier(createAlsPrincipalCarrier());
installUsageCarrier(createAlsUsageCarrier());

// The mirror of model-content.test.ts. There a TOOL hands the model something to look at, wire-only in
// both directions. Here a PERSON attaches it: bytes arrive by value at the submission boundary, are
// written to a MediaStore and replaced with a `file-ref` before anything is enqueued, and the runner
// resolves them back onto the outgoing copy newest-first inside a byte budget. What the two share is
// the invariant these tests exist to hold: no base64 ever reaches a session document.

const principal: Principal = { id: 'tester', type: 'user' };
const PNG = 'iVBORw0KGgo=';

function memStore(seed: Session): Store<Session> {
  const m = new Map<string, Session>([[seed.id, seed]]);
  return {
    get:    async id => m.get(id) ?? null,
    set:    async (id, v) => { m.set(id, v); },
    cas:    async () => { throw new Error('cas unused'); },
    delete: async () => { throw new Error('delete unused'); },
    query:  async () => { throw new Error('query unused'); },
  };
}

interface Held { meta: Omit<FileHandle, 'stream'>; bytes: Uint8Array }

function memMediaStore(): MediaStore & { held: Map<string, Held> } {
  const held = new Map<string, Held>();
  const handle = (h: Held): FileHandle => ({ ...h.meta, stream: async function *() { yield h.bytes; } });
  return {
    held,
    async put(name, mimeType, data, meta) {
      const chunks: Uint8Array[] = [];
      for await (const c of data) chunks.push(c);
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
      const id = name ?? crypto.randomUUID();
      const h: Held = {
        bytes,
        meta: {
          id, name: id, version: '1', mimeType, size: bytes.byteLength,
          createdAt: new Date().toISOString(), ...meta,
        },
      };
      held.set(id, h);
      return handle(h);
    },
    async get(id)  { const h = held.get(id); return h ? handle(h) : null; },
    async getByName(name) { const h = held.get(name); return h ? handle(h) : null; },
    async delete(id) { held.delete(id); },
    async *list(filter?: FileFilter) {
      for (const h of held.values()) {
        if (filter?.sessionId && h.meta.sessionId !== filter.sessionId) continue;
        yield handle(h);
      }
    },
    async putTemp() { throw new Error('putTemp unused'); },
  };
}

// One provider call, capturing exactly what went out.
function capturingProvider(seen: Message[][]): ProviderAdapter {
  return {
    name: 'fake',
    async health() { return { ok: true } as never; },
    complete(messages): AsyncIterable<CompletionEvent> {
      seen.push(messages);
      return (async function* () {
        yield { type: 'text-delta', delta: 'a cat' };
        yield { type: 'done' };
      })();
    },
  };
}

function makeRunner(store: Store<Session>, adapter: ProviderAdapter, media: MediaStore | undefined) {
  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  return createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter, config }),
    mediaStore:      () => media,
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  });
}

async function submit(
  store: Store<Session>, adapter: ProviderAdapter, media: MediaStore | undefined,
  sid: string, content: UserContent[],
): Promise<PipelineEvent[]> {
  const view = await makeRunner(store, adapter, media).open({
    sessionId: sid, signal: new AbortController().signal, content, provider: 'fake', principal,
  });
  const events: PipelineEvent[] = [];
  for await (const ev of view.events) { events.push(ev); if (ev.type === 'idle') break; }
  return events;
}

const image = (data: string, name: string): UserContent =>
  ({ type: 'image', data, mimeType: 'image/png' as MimeType, name });

// A PNG of the requested size: a real 8-byte signature then padding. The signature matters — ingestion
// magic-byte-checks a declared image/png, so a buffer of zeros is (correctly) refused as not-a-PNG, and
// a size test would then pass for the wrong reason. Chunked, because String.fromCharCode(...bytes) blows
// the argument limit around a megabyte — the same hazard the encoder under test chunks around.
function b64png(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

test('an attached image reaches the model and never reaches the store', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();
  const seen: Message[][] = [];

  await submit(store, capturingProvider(seen), media, session.id,
    [{ type: 'text', text: 'what is this?' }, image(PNG, 'cat.png')]);

  // On the wire: an inline image, in the user's own message rather than pinned after it.
  const outgoing = seen[0]!;
  const user     = outgoing.find(m => m.role === 'user')!;
  assert.equal(user.content.filter(c => c.type === 'image').length, 1, 'the image is inline on the wire');
  assert.equal(user.content.filter(c => c.type === 'file-ref').length, 0, 'and the ref it replaced is gone');
  assert.equal(user.content[0]?.type, 'text', 'text first, media after — the order submitted');

  // In the store: a reference, and only a reference.
  const saved  = (await store.get(session.id))!;
  const blocks = saved.messages.flatMap(m => m.content);
  assert.equal(blocks.filter(c => c.type === 'image').length, 0, 'no base64 survived into the session');
  const ref = blocks.find(c => c.type === 'file-ref');
  assert.ok(ref, 'a file-ref is what persisted');
  assert.equal(ref.name, 'cat.png', 'the display name rides on the block, so any FileStore preserves it');

  // In the media store: the bytes, attributed to the session that owns them.
  const stored = media.held.get(ref.fileId)!;
  assert.ok(stored, 'the bytes went to the media store');
  assert.equal(stored.meta.sessionId, session.id, 'scoped to the session — this is what makes it sweepable');
  assert.equal(stored.meta.namespace, MEDIA_NAMESPACE, 'and distinguishable from workspace files sharing a store');
});

test('an already-uploaded file-ref is passed through untouched', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();
  const handle  = await media.put(undefined, 'image/png' as MimeType,
    (async function *() { yield new Uint8Array([1, 2, 3]); })(), { sessionId: session.id });
  const seen: Message[][] = [];

  await submit(store, capturingProvider(seen), media, session.id, [
    { type: 'text', text: 'and this one?' },
    { type: 'file-ref', fileId: handle.id, name: 'dog.png', mimeType: 'image/png' as MimeType },
  ]);

  assert.equal(media.held.size, 1, 'nothing was re-uploaded');
  const user = seen[0]!.find(m => m.role === 'user')!;
  assert.equal(user.content.filter(c => c.type === 'image').length, 1, 'and it still resolves onto the wire');
});

test('media resolves newest-first, and what does not fit degrades to its ref', { timeout: 20000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();

  // Three turns, each attaching ~4MB — two fit the 8MB budget, the oldest does not.
  const big = b64png(4 * 1024 * 1024);
  const seen: Message[][] = [];
  for (const n of ['first', 'second', 'third']) {
    await submit(store, capturingProvider(seen), media, session.id,
      [{ type: 'text', text: n }, image(big, `${n}.png`)]);
  }

  const last = seen[2]!;
  const userMsgs = last.filter(m => m.role === 'user');
  assert.equal(userMsgs.length, 3, 'three user turns on the wire');
  assert.equal(userMsgs[0]!.content.filter(c => c.type === 'file-ref').length, 1,
    'the OLDEST fell out of the byte budget and stayed a ref — the converters degrade it');
  assert.equal(userMsgs[1]!.content.filter(c => c.type === 'image').length, 1, 'the middle one resolved');
  assert.equal(userMsgs[2]!.content.filter(c => c.type === 'image').length, 1, 'and so did the newest');

  // Every turn still persisted a ref and nothing else — the budget is a wire concern only.
  const saved = (await store.get(session.id))!;
  assert.equal(saved.messages.flatMap(m => m.content).filter(c => c.type === 'image').length, 0);
  assert.equal(media.held.size, 3, 'and all three files are still there, fetchable');
});

test('an oversized attachment is refused at the boundary, naming the file', { timeout: 20000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();
  const huge    = b64png(MAX_MEDIA_BYTES_PER_FILE + 1024);

  await assert.rejects(
    () => submit(store, capturingProvider([]), media, session.id, [image(huge, 'enormous.png')]),
    (e: unknown) => {
      assert.ok(isMediaRejectedError(e), 'a branded refusal, testable across a plugin-api copy');
      assert.equal(e.reason, 'too-large');
      assert.equal(e.file, 'enormous.png');
      assert.match(e.message, /enormous\.png/, 'the message names the file, not just the limit');
      return true;
    },
  );

  assert.equal(media.held.size, 0, 'nothing was written');
  assert.equal((await store.get(session.id))!.messages.length, 0, 'and no turn was enqueued to unwind');
});

test('a file that is not the type it claims is refused before it can poison the session', { timeout: 20000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();

  // The case that actually bit in testing: a 69-byte placeholder named .pdf. It sails past the size and
  // quota checks, reaches Anthropic, and 400s — mid-turn, after the message is persisted. The `file-ref`
  // is then in history, resolves into EVERY subsequent outgoing copy, and fails the session for good.
  const notReallyAPdf = btoa('%PFD-1.4 this is not a pdf');
  await assert.rejects(
    () => submit(store, capturingProvider([]), media, session.id,
      [{ type: 'document', data: notReallyAPdf, mimeType: 'application/pdf' as MimeType, name: 'note.pdf' }]),
    (e: unknown) => {
      assert.ok(isMediaRejectedError(e));
      assert.equal(e.reason, 'unreadable');
      assert.equal(e.file, 'note.pdf');
      return true;
    },
  );
  assert.equal(media.held.size, 0, 'nothing was stored, so nothing can be resolved later');
  assert.equal((await store.get(session.id))!.messages.length, 0, 'and no turn was enqueued');
});

test('a real file passes, and an unsniffable type is not guessed at', { timeout: 20000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();

  // A genuine PNG header, and a text file — whose bytes we know nothing about and must NOT refuse.
  await submit(store, capturingProvider([]), media, session.id, [
    image(PNG, 'real.png'),
    { type: 'document', data: btoa('id,name\n1,ada\n'), mimeType: 'text/csv' as MimeType, name: 'rows.csv' },
  ]);
  assert.equal(media.held.size, 2, 'both accepted — the check refuses only what it KNOWS is wrong');
});

test('with no MediaStore, text is unaffected and an attachment says why', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const seen: Message[][] = [];

  // The text-only deployment: never hears about media at all.
  await submit(store, capturingProvider(seen), undefined, session.id, [{ type: 'text', text: 'hello' }]);
  assert.equal(seen.length, 1, 'the turn ran normally');

  await assert.rejects(
    () => submit(store, capturingProvider([]), undefined, session.id, [image(PNG, 'cat.png')]),
    (e: unknown) => isMediaRejectedError(e) && e.reason === 'no-store',
  );
});

test('an image-only first turn still gets a title', { timeout: 15000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();

  await submit(store, capturingProvider([]), media, session.id, [image(PNG, 'holiday.png')]);

  assert.equal((await store.get(session.id))!.title, 'holiday.png',
    'a submission with no words of its own is still a submission');
});
