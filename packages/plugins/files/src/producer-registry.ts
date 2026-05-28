import type {
  FileHandle, FileProducer, MimeType, ProducerOptions,
  ProducerRegistry,
} from '@matatbread/matbot-core';

export class ProducerRegistryImpl implements ProducerRegistry {
  private readonly producers = new Map<string, FileProducer>();

  register(producer: FileProducer): void {
    this.producers.set(producer.mimeType, producer);
  }

  resolve(mimeType: MimeType): FileProducer | null {
    return this.producers.get(mimeType) ?? null;
  }

  async produce(
    mimeType: MimeType,
    data:     unknown,
    options?: ProducerOptions,
  ): Promise<FileHandle> {
    const producer = this.resolve(mimeType);
    if (!producer) {
      throw new Error(`No producer registered for mime "${mimeType}"`);
    }

    const signal = new AbortController().signal;
    const chunks: Uint8Array[] = [];
    for await (const chunk of producer.produce(data, options ?? {}, signal)) {
      chunks.push(chunk);
    }

    // Combine into a single in-memory FileHandle (useful for small outputs)
    const merged = mergeChunks(chunks);
    const now    = new Date().toISOString();
    const filename = options?.filename ?? `output.${producer.extension}`;

    return {
      id:        crypto.randomUUID(),
      version:   crypto.randomUUID(),
      name:      filename,
      mimeType,
      size:      merged.byteLength,
      createdAt: now,
      async *stream(_signal?: AbortSignal): AsyncIterable<Uint8Array> {
        yield merged;
      },
    };
  }
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out   = new Uint8Array(total);
  let offset  = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
