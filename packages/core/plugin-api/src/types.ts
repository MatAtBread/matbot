// ── Primitives ────────────────────────────────────────────────────────────────

export type Scalar  = string | number | boolean | null;
export type ISODate = string;
export type MimeType = string;
export type JSONSchema = Record<string, unknown>;

// ── Principal & Security ──────────────────────────────────────────────────────

export type CapabilityKind =
  | 'network'
  | 'filesystem'
  | 'spawn'
  | 'container'
  | 'audit:read';

export interface CapabilityGrant {
  capability: CapabilityKind;
  scope?:     string;
}

export interface Principal {
  id:       string;
  type:     'user' | 'agent' | 'system';
  grants:   CapabilityGrant[];
  contexts: string[];
  locale?:  string;
  tz?:      string;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export interface ModelParameters {
  temperature?:    number;
  maxTokens?:      number;
  topP?:           number;
  stopSequences?:  string[];
  [key: string]:   unknown;
}

export interface ProviderConfig {
  name:         string;
  type:         string;
  /** Plugin module specifier that provides this type's adapter (npm name or file URL). */
  module?:      string;
  endpoint?:    string;
  credentials:  Record<string, string>;
  model:        string;
  parameters?:  ModelParameters;
  fallback?:    string;
}

export type CompletionEvent =
  | { type: 'text-delta';          delta: string }
  | { type: 'tool-call';           id: string; name: string; input: unknown }
  | { type: 'tool-result';         id: string; result: unknown }
  | { type: 'thinking';            delta: string }
  | { type: 'thinking-block';      thinking: string; signature: string }
  | { type: 'redacted-thinking';   data: string }
  | { type: 'reasoning-block';     reasoning: string }
  | { type: 'refusal';             text: string }
  | { type: 'unknown-block';       blockType: string; raw: unknown }
  | { type: 'usage';               inputTokens: number; outputTokens: number; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number }
  | { type: 'done' };

export interface ProviderAdapter {
  readonly name: string;
  complete(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal
  ): AsyncIterable<CompletionEvent>;
  health(): Promise<HealthStatus>;
}

// ── Messages & Session ────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export type MessageContent =
  | { type: 'text';              text: string }
  | { type: 'thinking';          thinking: string; signature: string }
  | { type: 'redacted-thinking'; data: string }
  | { type: 'reasoning';         reasoning: string }
  | { type: 'image';             data: string; mimeType: MimeType }
  | { type: 'image-url';         url: string; detail?: 'low' | 'high' | 'auto' }
  | { type: 'document';          data: string; mimeType: MimeType; name?: string }
  | { type: 'audio';             data: string; mimeType: MimeType }
  | { type: 'tool-call';         id: string; name: string; input: unknown }
  | { type: 'tool-result';       id: string; result: unknown; isError?: boolean }
  | { type: 'refusal';           text: string }
  | { type: 'file-ref';          fileId: string; name: string; mimeType: MimeType }
  | { type: 'form';              fields: FormField[]; submitLabel?: string }
  | { type: 'form-response';     values: Record<string, string> }
  | { type: 'unknown-content';   blockType: string; raw: unknown };

export interface FormField {
  name:      string;
  label:     string;
  type:      'text' | 'password' | 'select' | 'confirm';
  options?:  string[];
  default?:  string;
  required?: boolean;
}

export interface Message {
  id:            string;
  role:          MessageRole;
  content:       MessageContent[];
  createdAt:     ISODate;
  traceId:       string;
  providerName?: string;
  metadata?:     Record<string, unknown>;
}

export type SessionStatus = 'active' | 'archived' | 'pinned';

export interface Session {
  id:                    string;
  version:               string;
  ownerPrincipalId:      string;
  actorPrincipalId?:     string;
  persona?:              string;
  title?:                string;
  status:                SessionStatus;
  contexts:              string[];
  messages:              Message[];
  parentSessionId?:      string;
  branchPointMessageId?: string;
  createdAt:             ISODate;
  updatedAt:             ISODate;
}

export type MessageKind =
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'tool-stdout'
  | 'tool-stderr'
  | 'file'
  | 'usage'
  | 'error'
  | 'form';

export interface InboundMessage {
  id:           string;
  /** Plain text string, or a pre-formed content array (e.g. a form-response). */
  content:      string | MessageContent[];
  attachments?: FileHandle[];
  metadata?:    Record<string, unknown>;
}

export interface OutboundMessage {
  id:         string;
  content:    string;
  artefacts?: FileHandle[];
  metadata?:  Record<string, unknown>;
}

// ── Pipeline hooks ────────────────────────────────────────────────────────────

export type HookPoint =
  | 'before:submit'
  | 'after:submit'
  | 'before:response'
  | 'after:response'
  | 'before:tool'
  | 'after:tool';

export interface RunConfig {
  principal:  Principal;
  provider:   string;
  persona?:   string;
  sessionId?: string;
  traceId?:   string;
}

export interface HookContext {
  session:   Session;
  principal: Principal;
  config:    RunConfig;
  signal:    AbortSignal;
  abort?:    string;
  /** Content to emit as a robo-user event so UIs render it as a user bubble. */
  inject?:   MessageContent[];
  [key: string]: unknown;
}

export interface Hook<C extends HookContext = HookContext> {
  point:     HookPoint;
  priority?: number;
  handler(ctx: C): Promise<C | void>;
}

// ── Storage ───────────────────────────────────────────────────────────────────

export type FilterExpr =
  | { field: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: Scalar }
  | { field: string; op: 'in';       value: Scalar[] }
  | { field: string; op: 'exists' }
  | { field: string; op: 'contains'; value: string }
  | { field: string; op: 'range';    gte?: Scalar; lte?: Scalar }
  | { and: FilterExpr[] }
  | { or:  FilterExpr[] }
  | { not: FilterExpr };

export interface VectorQuery {
  embedding?:  number[];
  text?:       string;
  topK:        number;
  minScore?:   number;
  preFilter?:  FilterExpr;
}

export interface SortSpec<T = unknown> {
  field:     (keyof T & string) | '_score' | '_recency';
  direction: 'asc' | 'desc';
}

export interface StoreQuery<T = unknown> {
  filter?:   FilterExpr;
  fullText?: string;
  vector?:   VectorQuery;
  sort?:     SortSpec<T>[];
  limit?:    number;
  offset?:   number;
  fields?:   (keyof T & string)[];
  explain?:  boolean;
}

export type CASResult<T> =
  | { ok: true;  doc: T }
  | { ok: false; current: T | null };

export interface QueryResult<T> {
  items:   Array<{ doc: T; score?: number; explanation?: string }>;
  total:   number;
  cursor?: string;
}

export interface Store<T extends { id: string; version: string }> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  cas(id: string, expected: string, next: T): Promise<CASResult<T>>;
  delete(id: string, expectedVersion?: string): Promise<boolean>;
  query(q: StoreQuery<T>): Promise<QueryResult<T>>;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export type ToolEvent =
  | { type: 'stdout';   chunk: string }
  | { type: 'stderr';   chunk: string }
  | { type: 'progress'; pct: number; message?: string }
  | { type: 'result';   value: unknown }
  | { type: 'file';     handle: FileHandle }
  | { type: 'error';    message: string; code?: number; stdout?: string; stderr?: string };

export interface ToolContext {
  callId:      string;
  session:     Session;
  principal:   Principal;
  signal:      AbortSignal;
  workdir?:    string;
  configPath?: string;
  files?:      FileStore;
  /** Prompt the user for input. The host provides a readline or form implementation. */
  prompt(question: string, defaultValue?: string): Promise<string>;
  /** Hot-load a plugin by specifier without restarting the process. */
  loadPlugin(specifier: string): Promise<void>;
}

export interface ToolExecutor {
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent>;
}

export interface Tool {
  name:         string;
  description:  string;
  inputSchema:  JSONSchema;
  requires?:    CapabilityKind[];
  executor:     ToolExecutor;
  pluginName?:  string;
}

// ── Files ─────────────────────────────────────────────────────────────────────

export interface FileHandle {
  id:          string;
  version:     string;
  name:        string;
  mimeType:    MimeType;
  size:        number;
  createdAt:   ISODate;
  sessionId?:  string;
  messageId?:  string;
  namespace?:  string;
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface FileFilter {
  sessionId?:     string;
  mimeType?:      string;
  namespace?:     string;
  createdAfter?:  ISODate;
  createdBefore?: ISODate;
}

export interface FileStore {
  /** Store a file. When `name` is provided, upserts by (name + namespace); otherwise always creates a new entry. */
  put(
    name:     string | undefined,
    mimeType: MimeType,
    data:     AsyncIterable<Uint8Array>,
    meta?:    { sessionId?: string; messageId?: string; namespace?: string }
  ): Promise<FileHandle>;
  get(id: string): Promise<FileHandle | null>;
  getByName(name: string, namespace?: string): Promise<FileHandle | null>;
  delete(id: string): Promise<void>;
  list(filter?: FileFilter): AsyncIterable<FileHandle>;
  putTemp(name: string, mimeType: MimeType, data: AsyncIterable<Uint8Array>): Promise<FileHandle>;
}

// ── Frontend ──────────────────────────────────────────────────────────────────

export interface FrontendAdapter {
  readonly name: string;
  subscribe:     MessageKind[];
  files?: {
    accept?:   MimeType[];
    produce?:  MimeType[];
    maxBytes?: number;
  };
  receive(): AsyncIterable<InboundMessage>;
  send(message: OutboundMessage): Promise<void>;
  health(): Promise<HealthStatus>;
}

// ── Vault ─────────────────────────────────────────────────────────────────────

export interface Vault {
  resolve(ref: string): Promise<string>;
  scrub(text: string): string;
}

// ── Health ────────────────────────────────────────────────────────────────────

export type HealthStatus =
  | { status: 'ok';       latencyMs?: number }
  | { status: 'degraded'; reason: string; latencyMs?: number }
  | { status: 'down';     reason: string };

export interface Healthcheck {
  readonly name: string;
  health(): Promise<HealthStatus>;
}

// ── Registries ────────────────────────────────────────────────────────────────

export interface ToolRegistry {
  register(tool: Tool): void;
  resolve(name: string): Tool | null;
  list(): readonly Tool[];
}
