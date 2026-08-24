import type { MediaStore, Message, MessageContent, MimeType, UserContent } from './types.js';
import { collectBytes, decodeBase64, encodeBase64, mediaRejectedError } from '@matatbread/matbot-plugin-api';

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

/** Per-file ceiling at the submission boundary. Refusing here — naming the file — is the point: the
 *  alternative is a provider 400 part-way through a turn the user already believes was sent.
 *
 *  It IS the residency budget rather than a second, larger number, because a file bigger than the
 *  window can never be resident: `spent + size > budget` is true on the very first item with
 *  `spent === 0`, so such a file would be stored, charged to the session quota, and then degraded to
 *  `[Attached file: x]` on every turn for the rest of the session — accepted, permanently invisible,
 *  and with no boundary having said a word. Deriving it makes that state unrepresentable rather than a
 *  second check to remember; raise the window and the cap follows. */
export const MAX_MEDIA_BYTES_PER_FILE = MEDIA_RESIDENCY_BYTES;

/** Per-session total, derived by summing what the store already holds for the session rather than kept
 *  as a counter: a counter is wrong after a restart, a swap, or anything deleting a file behind it. */
export const MAX_MEDIA_BYTES_PER_SESSION = 50 * 1024 * 1024;

const INLINE_ARMS = new Set(['image', 'document', 'audio']);

/**
 * Image types a vision endpoint actually decodes.
 *
 * `image/*` is the one prefix that cannot be admitted by prefix alone: a provider TRIES to decode
 * whatever the image arm carries and 400s on what it cannot, where an unrecognised document or audio
 * type degrades to a text note instead. So HEIC (what an iPhone camera roll hands back, and what a
 * `<input type="file">` with no `accept` will happily offer), SVG (XML — `read` gives the source, which
 * is the better answer anyway), BMP and TIFF have to be refused at the boundary rather than routed to
 * an arm that will fail: by the time the 400 arrives the `file-ref` is in persisted history, where it
 * resolves into every subsequent outgoing copy and fails the session for good.
 *
 * Same list and same reasoning as `workspace`'s `showArm`. The two stay separate because they answer
 * for separate stores; if a third ever needs it, this is the one to hoist.
 */
const DECODABLE_IMAGE: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Which inline arm a stored file comes back as, or null for a type that must not be sent at all. What
 * each adapter then does with an arm differs: google inlines all three; anthropic inlines images and
 * PDF/text documents and degrades the rest to a note; openai-compat inlines images only. A degraded arm
 * becomes a text note, never nothing — which is precisely why only `image/*` needs gating.
 *
 * Exported because `single_turn` resolves attachments through the same mapping: a mime-routing rule
 * with two copies is one that gets fixed in one of them.
 */
export function armFor(mimeType: string): 'image' | 'audio' | 'document' | null {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  if (base.startsWith('image/')) return DECODABLE_IMAGE.has(base) ? 'image' : null;
  if (base.startsWith('audio/')) return 'audio';
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
 * to a `file-ref` against the `MediaStore`, leave text untouched, and VET each ref a caller supplied
 * itself.
 *
 * A text-only submission never touches the store, so a deployment with no `MediaStore` registered is
 * completely unaffected — it only hears about one when someone actually attaches something, and then it
 * is told why rather than silently dropping it.
 *
 * Vetting the refs belongs here and nowhere else. A submission crosses a wire boundary, so a `fileId`
 * is the client's word about which bytes to send, and `resolveSessionMedia` inlines whatever it is
 * handed — no session, no namespace, no `allowed` consulted — which made "describe this" a read of any
 * file in the store. This is the only point that knows the session AND has a channel to say no: the
 * runner could only drop the block silently, mid-turn, for something the user watched itself attach.
 */
export async function ingestMedia(
  content:   readonly UserContent[],
  sessionId: string,
  store:     MediaStore | undefined,
): Promise<MessageContent[]> {
  // A ref counts: it is the arm that needs CHECKING rather than rewriting, and one cannot be honoured
  // without a store any more than a by-value arm can be stored without one.
  if (!content.some(c => INLINE_ARMS.has(c.type) || c.type === 'file-ref')) return content as MessageContent[];

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
    if (c.type === 'file-ref') {
      // Ownership, not `allowed`: every put below sets `allowed: true`, so the flag the HTTP read route
      // gates on cannot separate this session's media from another's. `sessionId` + namespace can, and
      // together they are strictly the stronger check. Reported as unknown rather than forbidden, for
      // the reason `GET /media/:id` gives: a refusal must not confirm that an id exists.
      const held = await store.get(c.fileId).catch(() => null);
      if (held === null || held.sessionId !== sessionId || held.namespace !== MEDIA_NAMESPACE) {
        throw mediaRejectedError('unknown-ref',
          `"${c.name}" is not media attached to this session. Attach the file itself, rather than a ` +
          'reference to one.', c.name);
      }
      out.push(c as MessageContent);
      continue;
    }
    if (!INLINE_ARMS.has(c.type)) { out.push(c as MessageContent); continue; }
    const arm  = c as Extract<UserContent, { data: string }>;
    const name = describe(arm.name, arm.mimeType);

    // Before the decode, because it needs no bytes and this is the cheapest of the three refusals.
    if (armFor(arm.mimeType) === null) {
      throw mediaRejectedError('unsupported-type',
        `"${name}" is ${arm.mimeType}, which no model endpoint decodes — sending it would fail the ` +
        'whole conversation, not just this message. Convert it to PNG or JPEG and attach that.', name);
    }

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
 * Turn-side resolution: which `file-ref`s get swapped for inline bytes on the outgoing copy. Returns
 * message-id → (file-id → the inline arm to stand in for that ref); a message with nothing resolvable
 * is absent from it, and so is a ref left outside the budget.
 *
 * Keyed per REF rather than returning each message's finished content array, because the array is not
 * final when this runs: a raced `screen` verdict folds durable blocks onto the user message *inside* the
 * round loop, and a caller splicing a whole array resolved at turn start would drop them from every
 * later round — persisted and on screen, but never sent. Handing back the substitutions instead leaves
 * the caller mapping blocks it still owns.
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
): Promise<Map<string, Map<string, MessageContent>>> {
  const resolved = new Map<string, Map<string, MessageContent>>();
  if (store === undefined) return resolved;

  let spent = 0;
  // Newest-first: the attachment the user is talking about right now is the one that must survive.
  for (let i = messages.length - 1; i >= 0 && spent < budget; i--) {
    const msg = messages[i]!;
    if (!msg.content.some(c => c.type === 'file-ref')) continue;

    const byFileId = new Map<string, MessageContent>();
    for (const c of msg.content) {
      if (c.type !== 'file-ref') continue;
      // Left out of the map, the ref stays exactly as it is — the converters already render it as
      // `[Attached file: x]`, which is true and the file is still fetchable by name. Three ways to
      // land there: a type no endpoint decodes, a ref the store no longer has, and the budget.
      const arm = armFor(c.mimeType);
      if (arm === null) continue;
      // One resolution per id: the same ref twice in a message must not be paid for twice, and both
      // blocks render from the one entry.
      if (byFileId.has(c.fileId)) continue;
      const handle = spent < budget ? await store.get(c.fileId).catch(() => null) : null;
      if (handle === null || spent + handle.size > budget) continue;
      spent += handle.size;
      const data = encodeBase64(await collectBytes(handle.stream(signal)));
      byFileId.set(c.fileId, arm === 'document'
        ? { type: 'document', data, mimeType: c.mimeType as MimeType, name: c.name }
        : { type: arm,        data, mimeType: c.mimeType as MimeType });
    }
    if (byFileId.size > 0) resolved.set(msg.id, byFileId);
  }
  return resolved;
}
