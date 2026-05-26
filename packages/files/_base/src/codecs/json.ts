import type { FileChunk, FileCodec, FileHandle } from '@matbot/core';

const decoder = new TextDecoder();

export const JsonCodec: FileCodec = {
  mimeTypes:  ['application/json'],
  extensions: ['.json'],

  async *process(handle: FileHandle, signal: AbortSignal): AsyncIterable<FileChunk> {
    let raw = '';
    for await (const chunk of handle.stream(signal)) {
      raw += decoder.decode(chunk, { stream: true });
    }
    raw += decoder.decode();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`JsonCodec: failed to parse "${handle.name}": ${String(e)}`);
    }
    yield { type: 'structured', data: parsed };
  },
};
