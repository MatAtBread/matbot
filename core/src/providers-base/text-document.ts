/**
 * A text-typed `document` arm, rendered as a plain text block.
 *
 * Every adapter needs this and none should use its protocol's document block for it. A document block
 * buys a title and citation support on the one endpoint that natively implements it, and is DISCARDED
 * by the Anthropic- and OpenAI-compatible shims most vendors front their models with: DeepSeek
 * substitutes the literal "[Unsupported Document]" server-side, so the model is told a file is attached
 * and shown nothing — strictly worse than either sending the bytes or refusing them at the boundary.
 * A text block is the one content shape every endpoint implements, and for text it is lossless: the
 * model reads the same characters either way.
 *
 * The name is folded into the framing because the alternative is a bare CSV dump with nothing saying
 * it is a file, which is the other half of what went wrong — a model that cannot tell content from
 * attachment goes looking for the attachment.
 */

/**
 * Structured-text types that are text without saying `text/`. A `+json`/`+xml` suffix (RFC 6839) is
 * matched too, so `application/vnd.api+json` needs no entry.
 *
 * An unlisted type is NOT guessed at, `application/octet-stream` above all: the browser hands that over
 * for any extension the OS could not place (`.yaml` on some installs), and sniffing it would mean
 * deciding that binary is text on the strength of it happening to decode.
 */
const TEXTUAL: ReadonlySet<string> = new Set([
  'application/json', 'application/ld+json', 'application/x-ndjson',
  'application/xml', 'application/yaml', 'application/x-yaml',
  'application/toml', 'application/csv', 'application/sql',
  'application/javascript', 'application/x-javascript', 'application/ecmascript',
  'application/x-sh', 'application/x-httpd-php', 'application/graphql',
]);

function isTextual(mimeType: string): boolean {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  return base.startsWith('text/') || base.endsWith('+json') || base.endsWith('+xml') || TEXTUAL.has(base);
}

/**
 * The text of a document arm that should be inlined as text, or null to leave the adapter's own
 * degradation in place (a PDF, an unrecognised type, or bytes that are not valid UTF-8 — a mislabelled
 * binary must not reach a prompt as mojibake, so the decode is `fatal`).
 *
 * `atob` yields one byte per char, so re-widen through TextDecoder rather than trusting it for anything
 * outside ASCII.
 */
export function textDocument(doc: { mimeType: string; data: string; name?: string | undefined }): string | null {
  if (!isTextual(doc.mimeType)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true })
      .decode(Uint8Array.from(atob(doc.data), ch => ch.charCodeAt(0)));
  } catch { return null; }
  const label = doc.name ?? doc.mimeType;
  return `--- ${label} ---\n${text}\n--- end of ${label} ---`;
}
