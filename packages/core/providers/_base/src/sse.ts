// Parses a Server-Sent Events stream into data payloads.
// Uses only Web APIs (ReadableStream, TextDecoder) — works in Node 24+ and browsers.
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data !== '[DONE]') yield data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
