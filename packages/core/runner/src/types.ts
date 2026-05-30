export type * from '@matatbread/matbot-plugin-api';

// ── Internal types (not part of the plugin API) ───────────────────────────────

import type {
  Session, MessageContent, FileHandle, ProviderAdapter,
} from '@matatbread/matbot-plugin-api';

export type PipelineEvent =
  | { type: 'text-delta';   delta: string;          traceId: string }
  | { type: 'thinking';     delta: string;          traceId: string }
  | { type: 'tool:start';   callId: string; name: string; input: unknown; traceId: string }
  | { type: 'tool:stdout';  callId: string; chunk: string;  traceId: string }
  | { type: 'tool:stderr';  callId: string; chunk: string;  traceId: string }
  | { type: 'tool:end';     callId: string; result: unknown; isError: boolean; traceId: string }
  | { type: 'file';         handle: FileHandle;     traceId: string }
  | { type: 'usage';        inputTokens: number; outputTokens: number; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number; traceId: string }
  | { type: 'done';         session: Session;       traceId: string }
  | { type: 'aborted';      reason: string; session: Session; traceId: string }
  | { type: 'robo-user';    content: MessageContent[]; traceId: string }
  | { type: 'error';        error: string;          traceId: string };

export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  resolve(name: string): ProviderAdapter;
}

