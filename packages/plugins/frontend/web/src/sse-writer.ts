/**
 * Serializes a value as a Server-Sent Events `data:` line.
 *
 * Returned string ends with the double-newline required by the SSE spec.
 * Safe to write directly to any writable stream.
 */
export function sseEvent(event: string, data: unknown): string {
  const json = JSON.stringify(data);
  return `event: ${event}\ndata: ${json}\n\n`;
}

export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}
