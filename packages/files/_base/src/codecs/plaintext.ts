import type { FileChunk, FileCodec, FileHandle } from '@matbot/core';

const decoder = new TextDecoder();

/**
 * Handles text/plain and text/markdown — both are just UTF-8 text.
 * Streams the file in chunks and emits them as `{ type: 'text' }` FileChunks.
 */
export const PlainTextCodec: FileCodec = {
  mimeTypes:  ['text/plain', 'text/markdown', 'text/x-markdown'],
  extensions: ['.txt', '.md', '.markdown'],

  async *process(handle: FileHandle, signal: AbortSignal): AsyncIterable<FileChunk> {
    let buffer = '';

    for await (const chunk of handle.stream(signal)) {
      buffer += decoder.decode(chunk, { stream: true });
    }
    // Flush the decoder
    buffer += decoder.decode();

    yield { type: 'text', content: buffer };
  },
};
