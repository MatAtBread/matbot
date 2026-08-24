/*
 * Base64 over bytes. Not part of the plugin *contract*, but shared by core, workspace and telegram —
 * the AsyncIterable-broadcaster case: a small stable utility earns a home here once a second package
 * needs it, rather than being copy-pasted. No `Buffer`: these run in the browser too.
 */

/** Bytes, not text: `atob` alone yields latin-1 code units, which is wrong for anything non-ASCII. */
export function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
}

export function encodeBase64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...bytes) blows the argument limit somewhere around a megabyte, and a
  // per-byte loop is an order of magnitude slower on the multi-megabyte files media allows.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
