export type * from '@matbot/plugin-api';

// ── Internal types (not part of the plugin API) ───────────────────────────────

import type {
  Session, Message, MessageContent, FileHandle, MimeType, JSONSchema,
  HookPoint, ProviderAdapter, FilterExpr, ISODate,
} from '@matbot/plugin-api';

export type PipelineEvent =
  | { type: 'submit:start'; message: Message;      traceId: string }
  | { type: 'text-delta';   delta: string;          traceId: string }
  | { type: 'thinking';     delta: string;          traceId: string }
  | { type: 'tool:start';   callId: string; name: string; input: unknown; traceId: string }
  | { type: 'tool:stdout';  callId: string; chunk: string;  traceId: string }
  | { type: 'tool:stderr';  callId: string; chunk: string;  traceId: string }
  | { type: 'tool:end';     callId: string; result: unknown; traceId: string }
  | { type: 'file';         handle: FileHandle;     traceId: string }
  | { type: 'usage';        inputTokens: number; outputTokens: number; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number; traceId: string }
  | { type: 'done';         session: Session;       traceId: string }
  | { type: 'aborted';      reason: string; session: Session; traceId: string }
  | { type: 'robo-user';    content: MessageContent[]; traceId: string }
  | { type: 'error';        error: string;          traceId: string };

export type AuditEventBase = {
  id:                string;
  version:           string;
  traceId:           string;
  ownerPrincipalId:  string;
  actorPrincipalId?: string;
  sessionId?:        string;
  at:                ISODate;
};

export type AuditEventKind =
  | { kind: 'submit';         messageId: string }
  | { kind: 'tool-call';      toolName: string; callId: string; granted: boolean }
  | { kind: 'memory-write';   entryId: string }
  | { kind: 'memory-recall';  resultCount: number }
  | { kind: 'file-store';     fileId: string; name: string }
  | { kind: 'hook-abort';     hookPoint: HookPoint; reason: string }
  | { kind: 'rate-limit';     resource: string }
  | { kind: 'error';          message: string };

export type AuditEvent = AuditEventBase & AuditEventKind;

export interface AuditLog {
  append(event: Omit<AuditEvent, 'id' | 'version'>): Promise<void>;
  query(filter: FilterExpr, limit?: number): AsyncIterable<AuditEvent>;
}

export interface Job<P = unknown> {
  id:          string;
  version:     string;
  type:        string;
  payload:     P;
  status:      'pending' | 'claimed' | 'done' | 'failed';
  claimedBy?:  string;
  claimedAt?:  ISODate;
  attempts:    number;
  maxAttempts: number;
  runAfter:    ISODate;
  failReason?: string;
  createdAt:   ISODate;
}

export interface JobQueue {
  enqueue<P>(type: string, payload: P, runAfter?: Date): Promise<Job<P>>;
  claim(type: string, workerId: string): Promise<Job | null>;
  complete(id: string, version: string): Promise<void>;
  fail(id: string, version: string, error: string): Promise<void>;
  watch(type: string, signal: AbortSignal): AsyncIterable<Job>;
}

export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  resolve(name: string): ProviderAdapter;
}

export type FileChunk =
  | { type: 'text';       content: string;    pageIndex?: number }
  | { type: 'image';      data: Uint8Array;   mimeType: MimeType; caption?: string }
  | { type: 'structured'; data: unknown;      schema?: JSONSchema }
  | { type: 'metadata';   data: Record<string, unknown> };

export interface FileCodec {
  mimeTypes:   MimeType[];
  extensions?: string[];
  process(handle: FileHandle, signal: AbortSignal): AsyncIterable<FileChunk>;
}

export interface ProducerOptions {
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface FileProducer {
  mimeType:  MimeType;
  extension: string;
  produce(data: unknown, options: ProducerOptions, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface CodecRegistry {
  register(codec: FileCodec): void;
  resolve(mimeType: MimeType, extension?: string): FileCodec | null;
  process(handle: FileHandle, signal: AbortSignal): AsyncIterable<FileChunk>;
}

export interface ProducerRegistry {
  register(producer: FileProducer): void;
  resolve(mimeType: MimeType): FileProducer | null;
  produce(mimeType: MimeType, data: unknown, options?: ProducerOptions): Promise<FileHandle>;
}
