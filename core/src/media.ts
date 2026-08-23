import type { MediaStore, Message, MessageContent, MimeType, UserContent } from './types.js';
import { mediaRejectedError } from '@matatbread/matbot-plugin-api';

/**
 * User-supplied session media: the two ends of the one path. Bytes arrive by value at the submission
 * boundary, are written through the `MediaStore` and replaced by a `file-ref` before anything is
 * enqueued ({@link ingestMedia}); the runner resolves those refs back to inline bytes on the *outgoing
 * copy only*, newest-first and inside a byte budget ({@link resolveSessionMedia}).
 *
 * Contrast the tool-media (`model-content`) path, which is wire-only in both directions and never had a
 * store: there the model pulls, here a person pushed. What the two share is the invariant — no base64
 * ever reaches a session document.
 */

/** Namespace session media is written under, so it is distinguishable from workspace files sharing a store. */
export const MEDIA_NAMESPACE = 'session-media';

/** Per-file ceiling at the submission boundary. Refusing here — naming the file — is the point: the
 *  alternative is a provider 400 part-way through a turn the user already believes was sent. */
export const MAX_MEDIA_BYTES_PER_FILE = 20 * 1024 * 1024;

/** Per-session total, derived by summing what the store already holds for the session rather than kept
 *  as a counter: a counter is wrong after a restart, a swap, or anything deleting a file behind it. */
export const MAX_MEDIA_BYTES_PER_SESSION = 50 * 1024 * 1024;

/**
 * How many bytes of media the outgoing copy may carry. Walked newest-first, so the freshest attachment
 * always makes it and an old one falls out; beyond the budget the `file-ref` is left alone and the
 * converters degrade it to `[Attached file: x]` — honest, already written, and the file is still there.
 *
 * A byte budget rather than a turn count because the cost being bounded is denominated in bytes: three
 * turns is a fine window for a thumbnail and a ruinous one for a 40MB PDF, and a count cannot tell them
 * apart. One knob; measure before adding a second.
 */
export const MEDIA_RESIDENCY_BYTES = 8 * 1024 * 1024;

const INLINE_ARMS = new Set(['image', 'document', 'audio']);

/** Which inline arm a stored file comes back as. The provider adapters take it from here — anthropic and
 *  google inline all three, openai-compat degrades document/audio to a text note. */
function armFor(mimeType: string): 'image' | 'audio' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Leading bytes that unambiguously identify a format. Only the types where a mismatch is a GUARANTEED
 * provider rejection — a model endpoint decodes these itself and 400s on anything it cannot parse.
 * Nothing else is sniffed: for `text/*`, audio, or an octet-stream we genuinely do not know, and
 * guessing would refuse valid files.
 */
const MAGIC: ReadonlyArray<{ mime: string; at: number; sig: readonly number[] }> = [
  { mime: 'image/png',  at: 0, sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', at: 0, sig: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif',  at: 0, sig: [0x47, 0x49, 0x46, 0x38] },                        // "GIF8"
  { mime: 'image/webp', at: 0, sig: [0x52, 0x49, 0x46, 0x46] },                        // "RIFF" (…WEBP at 8)
  { mime: 'image/webp', at: 8, sig: [0x57, 0x45, 0x42, 0x50] },                        // "WEBP"
  { mime: 'application/pdf', at: 0, sig: [0x25, 0x50, 0x44, 0x46] },                   // "%PDF"
];

/**
 * Does this file's content match the type it claims? Returns false only when we KNOW it does not.
 *
 * This is the boundary doing the one check it can: a provider decodes these formats itself and 400s
 * on anything it cannot parse, and a 400 arrives mid-turn — after the message is persisted, with the
 * `file-ref` now in history where it resolves into EVERY subsequent outgoing copy and fails the
 * session for good. A renamed file, a truncated upload or a placeholder is caught here instead, while
 * refusing still costs the user nothing but re-picking the file.
 *
 * It is not a validity check: a well-formed header on a structurally broken document still passes,
 * because only the provider can know that.
 */
function contentMatchesType(bytes: Uint8Array, mimeType: string): boolean {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  const rules = MAGIC.filter(m => m.mime === base);
  if (rules.length === 0) return true;                       // nothing known about this type — don't guess
  return rules.every(r =>
    bytes.length >= r.at + r.sig.length && r.sig.every((b, i) => bytes[r.at + i] === b));
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...bytes) blows the argument limit somewhere around a megabyte.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

async function collect(data: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of data) { chunks.push(c); total += c.byteLength; }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

function describe(name: string | undefined, mimeType: string): string {
  return name ?? `attachment.${mimeType.split('/')[1] ?? 'bin'}`;
}

function humanBytes(n: number): string {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The submission boundary, in one place so every frontend inherits it: rewrite each by-value media arm
 * to a `file-ref` against the `MediaStore`, leaving text and already-uploaded refs untouched.
 *
 * A text-only submission never touches the store, so a deployment with no `MediaStore` registered is
 * completely unaffected — it only hears about one when someone actually attaches something, and then it
 * is told why rather than silently dropping it.
 */
export async function ingestMedia(
  content:   readonly UserContent[],
  sessionId: string,
  store:     MediaStore | undefined,
): Promise<MessageContent[]> {
  if (!content.some(c => INLINE_ARMS.has(c.type))) return content as MessageContent[];

  if (store === undefined) {
    throw mediaRejectedError('no-store',
      'This deployment cannot accept attachments: no MediaStore is registered, so there is nowhere to ' +
      'put the bytes. Send the message as text, or register a media store.');
  }

  // Derived, not counted — see MAX_MEDIA_BYTES_PER_SESSION. One listing for the whole batch.
  let sessionBytes = 0;
  for await (const held of store.list({ sessionId })) sessionBytes += held.size;

  const out: MessageContent[] = [];
  for (const c of content) {
    if (!INLINE_ARMS.has(c.type)) { out.push(c as MessageContent); continue; }
    const arm  = c as Extract<UserContent, { data: string }>;
    const name = describe(arm.name, arm.mimeType);

    let bytes: Uint8Array;
    try { bytes = decodeBase64(arm.data); }
    catch { throw mediaRejectedError('unreadable', `"${name}" is not valid base64 and could not be read.`, name); }

    if (!contentMatchesType(bytes, arm.mimeType)) {
      throw mediaRejectedError('unreadable',
        `"${name}" does not contain valid ${arm.mimeType} data — the file may be corrupt, truncated, or ` +
        `misnamed. Sending it would fail the whole conversation, not just this message.`, name);
    }
    if (bytes.byteLength > MAX_MEDIA_BYTES_PER_FILE) {
      throw mediaRejectedError('too-large',
        `"${name}" is ${humanBytes(bytes.byteLength)}, over the ${humanBytes(MAX_MEDIA_BYTES_PER_FILE)} per-file limit.`, name);
    }
    sessionBytes += bytes.byteLength;
    if (sessionBytes > MAX_MEDIA_BYTES_PER_SESSION) {
      throw mediaRejectedError('session-quota',
        `Attaching "${name}" (${humanBytes(bytes.byteLength)}) would take this session over its ` +
        `${humanBytes(MAX_MEDIA_BYTES_PER_SESSION)} media limit. Start a new session, or attach less.`, name);
    }

    // Anonymous put: a UUID id, so two uploads of "photo.jpg" in one session are two files rather than
    // an upsert over each other. The display name rides on the `file-ref` block instead, which every
    // FileStore therefore preserves without having to.
    const handle = await store.put(undefined, arm.mimeType, (async function *() { yield bytes; })(),
      { sessionId, namespace: MEDIA_NAMESPACE, allowed: true });
    out.push({ type: 'file-ref', fileId: handle.id, name, mimeType: arm.mimeType });
  }
  return out;
}

/**
 * Turn-side resolution: which messages get their `file-ref`s swapped for inline bytes on the outgoing
 * copy, and what those messages then look like. Returns a message-id → replacement-content map for the
 * runner to splice; a message with nothing resolvable is absent from it.
 *
 * Computed ONCE per turn rather than per round: the bytes cannot change mid-turn, and re-deciding each
 * round would let a message drop out of the window between two provider calls — busting the prompt
 * cache and leaving the model referring to something no longer there.
 */
export async function resolveSessionMedia(
  messages: readonly Message[],
  store:    MediaStore | undefined,
  budget    = MEDIA_RESIDENCY_BYTES,
  signal?:  AbortSignal,
): Promise<Map<string, MessageContent[]>> {
  const resolved = new Map<string, MessageContent[]>();
  if (store === undefined) return resolved;

  let spent = 0;
  // Newest-first: the attachment the user is talking about right now is the one that must survive.
  for (let i = messages.length - 1; i >= 0 && spent < budget; i--) {
    const msg = messages[i]!;
    if (!msg.content.some(c => c.type === 'file-ref')) continue;

    let changed = false;
    const next: MessageContent[] = [];
    for (const c of msg.content) {
      if (c.type !== 'file-ref') { next.push(c); continue; }
      // Beyond the budget the ref is left exactly as it is — the converters already render it as
      // `[Attached file: x]`, which is true and the file is still fetchable by name.
      const handle = spent < budget ? await store.get(c.fileId).catch(() => null) : null;
      if (handle === null || spent + handle.size > budget) { next.push(c); continue; }
      spent += handle.size;
      const data = encodeBase64(await collect(handle.stream(signal)));
      const arm  = armFor(c.mimeType);
      next.push(arm === 'document'
        ? { type: 'document', data, mimeType: c.mimeType as MimeType, name: c.name }
        : { type: arm,        data, mimeType: c.mimeType as MimeType });
      changed = true;
    }
    if (changed) resolved.set(msg.id, next);
  }
  return resolved;
}
