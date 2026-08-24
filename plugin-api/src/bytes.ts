/*
 * Byte-stream helpers. Like ./base64.js: not part of the plugin *contract*, but shared often enough
 * that a copy per package was already drifting. Nothing node-specific — no `Buffer`.
 */

/**
 * Drain a byte stream into one array. `Uint8Array<ArrayBuffer>` rather than the `ArrayBufferLike`
 * default because callers hand the result to APIs that reject a `SharedArrayBuffer`-backed view
 * (an OPFS writable, a Drive upload body), and `new Uint8Array(n)` satisfies it for free.
 */
export async function collectBytes(data: AsyncIterable<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of data) { chunks.push(chunk); total += chunk.byteLength; }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}
