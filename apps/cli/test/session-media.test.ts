import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRunner, createSession, installPrincipalCarrier, installUsageCarrier, HookRegistry,
  isMediaRejectedError, MEDIA_NAMESPACE, MAX_MEDIA_BYTES_PER_FILE, MEDIA_RESIDENCY_BYTES,
} from '@matatbread/matbot-core';
import type {
  Session, Store, MediaStore, FileHandle, FileFilter, ProviderAdapter, ProviderConfig,
  CompletionEvent, PipelineEvent, Principal, Message, MessageContent, MimeType, UserContent,
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
  // As an upload-in-advance leg would write it: the same `sessionId` + namespace `ingestMedia` sets on
  // every put of its own. Those two fields are what the boundary checks a caller-supplied ref against.
  const handle  = await media.put(undefined, 'image/png' as MimeType,
    (async function *() { yield new Uint8Array([1, 2, 3]); })(),
    { sessionId: session.id, namespace: MEDIA_NAMESPACE });
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

test('a file-ref the session does not own is refused, and never confirms the id exists', { timeout: 20000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();

  // `UserContent` admits `file-ref` so an upload-in-advance leg can skip the rewrite — which makes the
  // `fileId` the CLIENT's word about which bytes to send, and the resolver inlines what it is handed.
  // Three ways it can be someone else's: another session's media, a file in this session with no
  // session at all, and one under a different namespace (a workspace file sharing the store).
  const elsewhere = await media.put(undefined, 'image/png' as MimeType,
    (async function *() { yield new Uint8Array([1, 2, 3]); })(),
    { sessionId: 'someone-elses-session', namespace: MEDIA_NAMESPACE });
  const unowned = await media.put(undefined, 'image/png' as MimeType,
    (async function *() { yield new Uint8Array([1, 2, 3]); })(), { namespace: MEDIA_NAMESPACE });
  const workspaceFile = await media.put(undefined, 'image/png' as MimeType,
    (async function *() { yield new Uint8Array([1, 2, 3]); })(),
    { sessionId: session.id, namespace: 'workspace', allowed: true });

  for (const [id, what] of [[elsewhere.id, 'another session'], [unowned.id, 'no session'],
                            [workspaceFile.id, 'another namespace']] as const) {
    await assert.rejects(
      () => submit(store, capturingProvider([]), media, session.id, [
        { type: 'text', text: 'describe this' },
        { type: 'file-ref', fileId: id, name: 'dog.png', mimeType: 'image/png' as MimeType },
      ]),
      (e: unknown) => {
        assert.ok(isMediaRejectedError(e), `a ref from ${what} is refused`);
        assert.equal(e.reason, 'unknown-ref');
        assert.equal(e.file, 'dog.png');
        // Unknown, never forbidden: the same rule GET /media/:id follows. A refusal that said
        // "not yours" would confirm the id exists, which is the half an attacker does not have.
        assert.doesNotMatch(e.message, /forbid|denied|not yours|permission/i);
        return true;
      },
    );
  }

  // `allowed` cannot stand in for this check: every media put sets it true, so it does not separate
  // one session's media from another's.
  assert.equal(media.held.get(elsewhere.id)!.meta.sessionId, 'someone-elses-session');
  assert.equal((await store.get(session.id))!.messages.length, 0, 'and nothing was enqueued to unwind');
});

test('an image type no endpoint decodes is refused rather than routed to an arm that 400s', { timeout: 20000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();

  // The iPhone case: a `<input type="file">` given `image/*` hands back HEIC from the camera roll. It
  // would be stored, become a persisted `file-ref`, and then 400 the request on THIS turn and every
  // later one — `image/*` is the one arm a provider tries to decode, where an unknown document or
  // audio type degrades to a text note instead.
  for (const mimeType of ['image/heic', 'image/svg+xml', 'image/bmp', 'image/tiff'] as const) {
    await assert.rejects(
      () => submit(store, capturingProvider([]), media, session.id,
        [{ type: 'image', data: PNG, mimeType: mimeType as MimeType, name: `photo.${mimeType.split('/')[1]}` }]),
      (e: unknown) => {
        assert.ok(isMediaRejectedError(e), `${mimeType} is refused`);
        assert.equal(e.reason, 'unsupported-type');
        assert.match(e.message, new RegExp(mimeType.replace('+', '\\+')), 'the message names the type');
        return true;
      },
    );
  }

  assert.equal(media.held.size, 0, 'nothing was written for any of them');

  // A document or audio type nobody recognises is NOT refused: the adapters degrade it to a note.
  const seen: Message[][] = [];
  await submit(store, capturingProvider(seen), media, session.id,
    [{ type: 'document', data: btoa('hello'), mimeType: 'application/x-fnarr' as MimeType, name: 'thing.fnarr' }]);
  assert.equal(media.held.size, 1, 'an unrecognised document is stored, not refused');
});

test('the per-file cap is the residency window, so nothing is accepted that could never be shown', { timeout: 20000 }, async () => {
  // The relationship, not the number: a file over the outgoing-copy budget can never be resident
  // (`spent + size > budget` is true on the first item, with `spent === 0`), so accepting one would
  // store it, charge it to the session total, and leave it permanently invisible with nothing said.
  assert.equal(MAX_MEDIA_BYTES_PER_FILE, MEDIA_RESIDENCY_BYTES,
    'the per-file cap derives from the residency budget rather than being a second, larger number');

  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();
  const seen: Message[][] = [];

  // Just inside it: accepted AND resolved onto the wire, which is the property the equality buys.
  await submit(store, capturingProvider(seen), media, session.id,
    [image(b64png(MEDIA_RESIDENCY_BYTES - 4096), 'big.png')]);
  const user = seen[0]!.find(m => m.role === 'user')!;
  assert.equal(user.content.filter(c => c.type === 'image').length, 1,
    'the largest file the boundary accepts is one the resolver can still show');
});

test('a durable fold onto a message carrying media survives onto the wire', { timeout: 20000 }, async () => {
  const session = createSession();
  const store   = memStore(session);
  const media   = memMediaStore();
  const seen: Message[][] = [];

  // Session media is resolved ONCE, before the round loop. A raced screen verdict folds durable
  // robo-user blocks onto that same user message afterwards, so a splice that substituted the whole
  // content array would put back the pre-fold copy — persisted and on screen, but never sent.
  const durable: MessageContent[] = [{ type: 'text', text: 'RACED: the user means the cat', origin: 'robo' }];
  // One-shot, as the name says: a `claim()` that kept answering would have the runner fold and re-run
  // the round forever, since a fired verdict is what tells it to restart.
  let claimed = false;
  const hooks = new HookRegistry();
  hooks.register({
    on: 'screen',
    handler: () => ({ deferred: { claim: () => (claimed ? undefined : (claimed = true, { durable })) } }),
  }, 'racer');

  const config: ProviderConfig = { name: 'fake', module: 'fake', model: 'fake' };
  const view = await createSessionRunner({
    store,
    resolveProvider: async () => ({ adapter: capturingProvider(seen), config }),
    mediaStore:      () => media,
    hooks,
    loadPlugin:      async () => { throw new Error('loadPlugin unused'); },
    unloadPlugin:    async () => false,
  }).open({
    sessionId: session.id, signal: new AbortController().signal, provider: 'fake', principal,
    content: [{ type: 'text', text: 'what is this?' }, image(PNG, 'cat.png')],
  });
  for await (const ev of view.events) if (ev.type === 'idle') break;

  const user = seen[0]!.find(m => m.role === 'user')!;
  assert.equal(user.content.filter(c => c.type === 'image').length, 1, 'the image reached the model');
  assert.ok(user.content.some(c => c.type === 'text' && c.text.startsWith('RACED:')),
    'and so did the durable block folded on after media was resolved');

  const saved = (await store.get(session.id))!;
  const savedUser = saved.messages.find(m => m.role === 'user')!;
  assert.ok(savedUser.content.some(c => c.type === 'text' && c.text.startsWith('RACED:')),
    'the fold is persisted, which is why dropping it from the wire only shows up as a bad answer');
  assert.equal(saved.messages.flatMap(m => m.content).filter(c => c.type === 'image').length, 0,
    'and the bytes still never reached the document');
});
