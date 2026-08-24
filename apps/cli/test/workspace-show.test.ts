import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '@matatbread/matbot-core';
import type { FileHandle, FileFilter, FileStore, MimeType, Session, ToolContext, ToolEvent, Vault } from '@matatbread/matbot-core';
import { plugin as workspacePlugin } from '../../../plugins/workspace/src/index.js';

// `workspace_action show` is matbot's first real producer of `model-content` — the PULL half of the media
// model, where the model asks to look at a stored file rather than a person pushing one at it.
//
// It exists because `read` structurally cannot do this: its result is a string, so base64 there is 4/3 of
// the file persisted into the session document and re-sent every round, for something the model still
// cannot see. That asymmetry — bytes to the eyes, metadata to the transcript — is what these tests pin.
//
// The generic mechanism (pinning, rest-of-turn residency, never persisted) is covered by
// `model-content.test.ts` against a fake tool. What is under test HERE is the producer: which files it
// agrees to show, which it refuses and why, and that it hands over an arm rather than a string.

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

interface Held { meta: Omit<FileHandle, 'stream'>; bytes: Uint8Array }

/** A FileStore holding whatever a test seeds, sized however the test says (so a 40MB case costs nothing). */
function memFiles(): FileStore & { seed(name: string, mimeType: string, bytes: Uint8Array, size?: number): void } {
  const held = new Map<string, Held>();
  const handle = (h: Held): FileHandle => ({ ...h.meta, stream: async function *() { yield h.bytes; } });
  return {
    seed(name, mimeType, bytes, size) {
      held.set(name, { bytes, meta: {
        id: name, name, version: '1', mimeType: mimeType as MimeType,
        size: size ?? bytes.byteLength, createdAt: '', namespace: 'workspace', allowed: true,
      } });
    },
    async put(name, mimeType, data) {
      const chunks: Uint8Array[] = [];
      for await (const c of data) chunks.push(c);
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
      const id = name ?? crypto.randomUUID();
      const h: Held = { bytes, meta: { id, name: id, version: '1', mimeType, size: bytes.byteLength, createdAt: '' } };
      held.set(id, h);
      return handle(h);
    },
    async get(id) { const h = held.get(id); return h ? handle(h) : null; },
    async getByName(n) { const h = held.get(n); return h ? handle(h) : null; },
    async delete(id) { held.delete(id); },
    async *list(_filter?: FileFilter) { for (const h of held.values()) yield handle(h); },
    async putTemp() { throw new Error('putTemp unused'); },
  };
}

const tool = workspacePlugin.tools!.find(t => t.name === 'workspace_action')!;

async function run(files: FileStore, input: Record<string, unknown>): Promise<ToolEvent[]> {
  const ctx = {
    callId: 'c1', session: createSession() as Session, signal: new AbortController().signal,
    vault: { resolve: async (v: string) => v } as unknown as Vault, files,
    prompt: async () => { throw new Error('prompt unused'); },
    loadPlugin: async () => { throw new Error('unused'); }, unloadPlugin: async () => false,
  } as unknown as ToolContext;
  const out: ToolEvent[] = [];
  for await (const ev of tool.executor.execute(input, ctx)) out.push(ev);
  return out;
}

const show = (files: FileStore, name: string): Promise<ToolEvent[]> => run(files, { action: 'show', name });

const errorOf = (events: ToolEvent[]): string => {
  const e = events.find(ev => ev.type === 'error');
  assert.ok(e, `expected a refusal, got ${JSON.stringify(events.map(ev => ev.type))}`);
  return e.message;
};

test('an image goes to the model as an arm, and to the transcript as metadata', async () => {
  const files = memFiles();
  files.seed('Inception.png', 'image/png', PNG_BYTES);

  const events = await show(files, 'Inception.png');
  assert.deepEqual(events.map(e => e.type), ['model-content', 'result'], 'both, in that order');

  const media = events.find(e => e.type === 'model-content')!;
  assert.equal(media.content.length, 1);
  assert.equal(media.content[0]!.type, 'image');
  assert.equal((media.content[0] as { mimeType: string }).mimeType, 'image/png');

  // The whole point: the bytes are on the media event and NOWHERE on the result, which is what gets
  // written into the session document.
  const result = events.find(e => e.type === 'result')!;
  assert.deepEqual(result.value, { name: 'Inception.png', mimeType: 'image/png', bytes: 10 });
  assert.doesNotMatch(JSON.stringify(result.value), /iVBOR|AQI=/, 'no base64 rides the result');
});

test('a PDF is a document arm and keeps its name; audio is an audio arm', async () => {
  const files = memFiles();
  files.seed('spec.pdf',  'application/pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  files.seed('memo.mp3',  'audio/mpeg',      new Uint8Array([1, 2, 3]));

  const pdf = (await show(files, 'spec.pdf')).find(e => e.type === 'model-content')!;
  // A document arm carries `name` — it is the title the provider renders, and an untitled document in a
  // batch of several is unaddressable in the model's own reply.
  assert.deepEqual(
    { ...pdf.content[0], data: '<bytes>' },
    { type: 'document', mimeType: 'application/pdf', name: 'spec.pdf', data: '<bytes>' });

  const mp3 = (await show(files, 'memo.mp3')).find(e => e.type === 'model-content')!;
  assert.equal(mp3.content[0]!.type, 'audio');
});

test('SVG and text are refused toward `read`, which is the better answer for them anyway', async () => {
  const files = memFiles();
  files.seed('diagram.svg', 'image/svg+xml',            new Uint8Array([0x3c, 0x73]));
  files.seed('notes.md',    'text/markdown; charset=utf-8', new Uint8Array([0x23]));

  // The only two refusals, and neither is about capability: `read` hands over the source, which is what
  // you actually want from markup or prose. SVG is inside `image/*` and is the one exclusion there.
  for (const [name, type] of [['diagram.svg', 'image/svg+xml'], ['notes.md', 'text/markdown']] as const) {
    const message = errorOf(await show(files, name));
    assert.ok(message.includes(type), `the refusal names the type it got: ${message}`);
    assert.match(message, /action "read"/, 'and points at the action that can help');
  }
});

test('a type we hold no opinion about is shown, not refused — the endpoint gets to reject it', async () => {
  const files = memFiles();
  files.seed('blob.bin',  'application/octet-stream', new Uint8Array([0x00]));
  files.seed('take.flac', 'audio/flac',               new Uint8Array([0x66, 0x4c, 0x61, 0x43]));

  // There is no per-model mime capability table here, so refusing would be guessing on the model's
  // behalf — and the guess was wrong in the obvious case (see below). Being wrong this way costs one
  // turn: tool media is wire-only and dies with it, unlike a persisted session `file-ref`.
  const blob = (await show(files, 'blob.bin')).find(e => e.type === 'model-content')!;
  assert.equal(blob.content[0]!.type, 'document', 'an unrecognised binary goes over as a document arm');

  const flac = (await show(files, 'take.flac')).find(e => e.type === 'model-content')!;
  assert.equal(flac.content[0]!.type, 'audio');
});

test('audio written through the tool is typed as audio, not octet-stream', async () => {
  const files = memFiles();

  // The bug this closes: MIME_MAP had no audio extension at all, so `mimeFromName` — the ONLY source of
  // a workspace file's type on write — fell to octet-stream for every .mp3. `show` then refused it and
  // sent the model to `read`, which hands back base64 it cannot hear: the exact dead end `show` exists
  // to close, in the tool that advertises audio.
  for (const [name, arm] of [['memo.mp3', 'audio'], ['take.wav', 'audio'], ['clip.m4a', 'audio'],
                             ['song.ogg', 'audio'], ['voice.opus', 'audio']] as const) {
    const written = await run(files, { action: 'write', name, content: 'not really audio' });
    assert.ok(!written.some(e => e.type === 'error'), `wrote ${name}: ${JSON.stringify(written)}`);
    const shown = (await show(files, name)).find(e => e.type === 'model-content');
    assert.ok(shown, `${name} is shown rather than refused`);
    assert.equal(shown.content[0]!.type, arm, `${name} reaches the model as an ${arm} arm`);
  }
});

test('an oversized file is refused on its declared size, before any read', async () => {
  const files = memFiles();
  // Declared 40MB, one byte actually held. The refusal quotes 40MB, so it came off the handle's `size`
  // and not from counting what was streamed — there is no reason to pull 40MB into memory to learn it
  // was too big.
  files.seed('huge.png', 'image/png', new Uint8Array([0x89]), 40 * 1024 * 1024);

  const message = errorOf(await show(files, 'huge.png'));
  assert.match(message, /40\.0MB/);
  assert.match(message, /8MB limit/);
  assert.match(message, /re-sent on every subsequent round/, 'says WHY, so the model can pick a smaller one');
});

test('a missing file and a path escape are refused as they are for read', async () => {
  const files = memFiles();
  assert.match(errorOf(await show(files, 'nope.png')),      /File not found: "nope\.png"/);
  assert.match(errorOf(await show(files, '../secret.png')), /must name a file inside the workspace/);
  assert.match(errorOf(await show(files, '')),              /requires "name"/);
});
