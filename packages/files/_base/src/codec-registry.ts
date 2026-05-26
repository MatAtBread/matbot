import type { FileChunk, FileCodec, FileHandle, CodecRegistry, MimeType } from '@matbot/core';

export class CodecRegistryImpl implements CodecRegistry {
  private readonly byMime      = new Map<string, FileCodec>();
  private readonly byExtension = new Map<string, FileCodec>();

  register(codec: FileCodec): void {
    for (const mime of codec.mimeTypes) {
      this.byMime.set(mime, codec);
    }
    for (const ext of codec.extensions ?? []) {
      this.byExtension.set(ext.startsWith('.') ? ext : `.${ext}`, codec);
    }
  }

  resolve(mimeType: MimeType, extension?: string): FileCodec | null {
    return this.byMime.get(mimeType)
        ?? (extension ? this.byExtension.get(extension.startsWith('.') ? extension : `.${extension}`) : null)
        ?? null;
  }

  async *process(handle: FileHandle, signal: AbortSignal): AsyncIterable<FileChunk> {
    const ext   = handle.name.includes('.')
      ? `.${handle.name.split('.').pop() ?? ''}`
      : undefined;
    const codec = this.resolve(handle.mimeType, ext);
    if (!codec) {
      throw new Error(`No codec registered for mime "${handle.mimeType}" (file: ${handle.name})`);
    }
    yield* codec.process(handle, signal);
  }
}
