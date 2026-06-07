import type { MatbotPlugin } from './plugin.js';

// ── Primitives ────────────────────────────────────────────────────────────────

export type Scalar  = string | number | boolean | null;
export type ISODate = string;
export type MimeType = string;
export type JSONSchema = Record<string, unknown>;

// ── Principal ───────────────────────────────────────────────────────────────

/** Identity of whatever initiated an operation — a turn, a tool call, a store read/write.
 *  Carried through so an implementation can attribute or test the origin; it grants nothing. */
export interface Principal {
  id:    string;
  type:  'user' | 'agent' | 'system';
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
  /** Plugin module specifier (npm name or file URL) that provides the adapter for this provider. */
  module:       string;
  model:        string;
  credentials?:  Record<string, string>;
  endpoint?:    string;
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

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'marker';

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
  | { type: 'marker';            creator: string; data: unknown }
  | { type: 'unknown-content';   blockType: string; raw: unknown };

/**
 * A marker is opaque, durable annotation carried in the message stream: links, status,
 * cross-references that are meaningful to a frontend but transparent to the LLM. They are
 * persisted unchanged, elided from provider submission, and deliberately preserved by
 * session compaction (removing one can break things — e.g. a pointer back to an ancestor
 * session). Any code with session access may emit one, normally as its own message.
 *
 * `creator` is the emitting plugin's reference; `data` is anything serialisable. For
 * per-creator type safety, augment `MarkerData` and read/write via `Marker<'your-creator'>`:
 *
 *   declare module '@matatbread/matbot-plugin-api' {
 *     interface MarkerData { 'split-session': { peerSessionId: string } }
 *   }
 *
 * Unregistered creators fall back to `data: unknown`. The base `MessageContent` member stays
 * loose (`creator: string`) so the union and its exhaustive switches are unaffected.
 */
export interface MarkerData {}

export type Marker<K extends string = string> = {
  type:    'marker';
  creator: K;
  data:    K extends keyof MarkerData ? MarkerData[K] : unknown;
};

export interface FormField {
  name:        string;
  label:       string;
  type:        'text' | 'password' | 'select' | 'confirm';
  options?:    string[];
  /** select-only: render an "Other…" affordance that lets the user type a free-form answer instead
   *  of picking an option. The typed value is returned verbatim, on the same channel as a pick —
   *  callers never learn whether the answer was a preset or free text. Ignored for other types. */
  allowOther?: boolean;
  default?:    string;
  required?:   boolean;
  /** Presentation hint only (default true): whether the frontend offers a cancel affordance (the
   *  "give up" path — see `PromptFn`). Set false to render a hard-blocking prompt with no out. The
   *  runner and server never consult this; a frontend with no cancel UI simply can't fire one. */
  cancelable?: boolean;
}

/**
 * Canonical values a `type: 'confirm'` prompt resolves to. The rendered label and buttons are a
 * cosmetic, host-specific concern (and may be localised), so consumers MUST branch on these tokens
 * — never on the displayed string. Compare case-insensitively to tolerate host casing differences.
 */
export const CONFIRM_YES = 'yes';
export const CONFIRM_NO  = 'no';

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

// ── System context ────────────────────────────────────────────────────────────

export type SystemContextContributor = (ctx: {
  session:   Session;
  principal: Principal;
  signal:    AbortSignal;
}) => string | null | Promise<string | null>;

export interface SystemContextRegistry {
  register(contributor: SystemContextContributor, pluginName?: string): void;
  removeByPlugin(pluginName: string): void;
  /** Calls all contributors and joins non-null, non-empty results with double newlines. */
  build(ctx: { session: Session; principal: Principal; signal: AbortSignal }): Promise<string | null>;
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

/**
 * Context for `before:tool` / `after:tool` hooks. Carries the resolved tool and the
 * pending call so hooks can inspect or validate it. Setting `rejectTool` makes the
 * runner skip execution and return an error tool-result to the model (which can then
 * self-correct), without aborting the whole turn or breaking tool_use/tool_result pairing.
 */
export interface ToolHookContext extends HookContext {
  toolCall:    { id: string; name: string; input: unknown };
  tool:        Tool;
  rejectTool?: { message: string };
}

export interface Hook<C extends HookContext = HookContext> {
  point:       HookPoint;
  priority?:   number;
  pluginName?: string;
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

// ── Knowledge index ───────────────────────────────────────────────────────────

export interface KnowledgeEntry {
  id:           string;
  version:      string;
  entities:     string[];
  tags:         string[];
  summary:      string;
  content:      string;
  contentHash?: string;
  source:       { type: string; uuid: string };
  confidence?:  number;
  createdAt:    string;
  updatedAt:    string;
}

export interface KnowledgeIndex {
  index(entry: KnowledgeEntry): Promise<void>;
  search(terms: Array<{ term: string; context?: string }>, signal: AbortSignal): Promise<KnowledgeEntry[]>;
  /** Enumerate all indexed entries. When present, register('knowledge', …) drains these into the incoming backend. */
  entries?(): Iterable<KnowledgeEntry>;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export type ToolEvent =
  | { type: 'stdout';   chunk: string }
  | { type: 'stderr';   chunk: string }
  | { type: 'progress'; pct: number; message?: string }
  | { type: 'result';   value: unknown }
  | { type: 'file';     handle: FileHandle }
  | { type: 'error';    message: string; code?: number; stdout?: string; stderr?: string };

/**
 * Ask the user a question and resolve with their answer. The host supplies the
 * implementation — readline in the CLI, an SSE round-trip in the web frontend. This is
 * matbot's single mechanism for eliciting user input at runtime; it is injected both into
 * tool execution (`ToolContext.prompt`) and into plugin loading (collision resolution in setup).
 *
 * Two call forms:
 *   - `(question, defaultValue?)` — free text; resolves to the typed string (or the default).
 *   - `(field: FormField)` — a single structured field (`select`/`confirm`/`password`/`text`),
 *     letting rich frontends render real controls (buttons, masked input). Frontends that can't
 *     render it fall back to `field.label` as plain text. Resolves to the chosen/typed value.
 *
 * Cancellation is the "we can't proceed — give up" path (distinct from a graceful "decline", which
 * is simply one of the offered `options`). The host rejects the promise with `PromptCancelledError`
 * and abandons the current turn, returning to idle; a caller's surrounding try/catch turns the
 * rejection into a tool error that closes the tool call cleanly.
 *     This reuses `FormField` rather than a parallel type; it is a one-shot request/response and
 *     deliberately does NOT engage the session-bound `form`/`form-response` flow.
 */
export interface PromptFn {
  (question: string, defaultValue?: string): Promise<string>;
  (field: FormField): Promise<string>;
}

export interface ToolContext {
  callId:      string;
  session:     Session;
  principal:   Principal;
  signal:      AbortSignal;
  vault:       Vault;
  workdir?:    string;
  configPath?: string;
  files?:      FileStore;
  /** Prompt the user for input. The host provides a readline or form implementation. */
  prompt:      PromptFn;
  /** Hot-load a plugin by specifier without restarting the process. Returns the loaded plugin. */
  loadPlugin(specifier: string): Promise<MatbotPlugin>;
  /**
   * Hot-unload a plugin by specifier, removing its tools, hooks, and system context contributions.
   * Resolves `true` if a plugin was actually resident and unloaded, `false` if there was nothing
   * to unload. A failed `teardown()` (e.g. timeout) still throws — the plugin was resident in that case.
   */
  unloadPlugin(specifier: string): Promise<boolean>;
}

export interface ToolExecutor {
  execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent>;
}

export interface Tool {
  name:         string;
  description:  string;
  inputSchema:  JSONSchema;
  executor:     ToolExecutor;
  pluginName?:  string;
}

// ── Files ─────────────────────────────────────────────────────────────────────

export interface FileMetaData {
  id:          string;
  version:     string;
  name:        string;
  mimeType:    MimeType;
  size:        number;
  createdAt:   ISODate;
  sessionId?:  string;
  messageId?:  string;
  namespace?:  string;
}

export interface FileHandle extends FileMetaData {
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export type FileEvent = FileMetaData & { changed: Array<keyof FileMetaData> };

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
  /** Observe file changes. Implementations that cannot watch their backing store omit this. */
  watch(signal?: AbortSignal): AsyncIterable<FileEvent>;
}

// ── Frontend ──────────────────────────────────────────────────────────────────

/**
 * Passed to `services.registerFrontend()` by a plugin declaring itself a frontend. A frontend
 * owns its own I/O (an HTTP server, a bot connection, a REPL); matbot only needs to know it
 * exists. This object is the growth point for frontend-level capability advertisement
 * (accepted/produced MIME types, size limits, …) as media support lands.
 */
export interface FrontendInfo {
  name: string;
}

// ── Vault ─────────────────────────────────────────────────────────────────────

/**
 * The primitives a vault backend must implement. Resolution, redaction, and the three
 * low-level store operations the smart `createSecret` policy composes. A backend implements
 * `Vault` (which is `VaultSpec` plus that policy); plugins are handed a `Vault`.
 */
export interface VaultSpec {
  /** Resolve ${NAME} placeholders by looking up the named value; throws MissingSecretError for any miss. */
  resolve(ref: string): Promise<string>;
  scrub(text: string): string;
  /** Store `value` under exactly `name`, overwriting. The literal write; no reference/dedup logic. */
  writeSecret(name: string, value: string): Promise<void>;
  /** Whether a secret is stored under this exact name. */
  hasKey(name: string): boolean;
  /**
   * The name a value is already stored under, if any. Optional: backends that can't (or won't)
   * reverse-index omit it, and `createSecret`'s dedup step is skipped.
   */
  findByValue?(value: string): string | undefined;
}

export interface Vault extends VaultSpec {
  /**
   * Store a secret coming (often) from a user via the LLM, where we cannot tell a real value
   * from a key name they typed by mistake. Returns the key name callers MUST reference — not
   * necessarily the `name` requested:
   *   - `value` is already a known key name → returns `value` (it was a reference, not a secret)
   *   - `value` already stored under another name → returns that name (dedup)
   *   - otherwise → writes under `name` and returns `name`
   */
  createSecret(name: string, value: string): Promise<string>;
}

// ── Health ────────────────────────────────────────────────────────────────────

export type HealthStatus =
  | { status: 'ok';       latencyMs?: number }
  | { status: 'degraded'; reason: string; latencyMs?: number }
  | { status: 'down';     reason: string };

// ── Registries ────────────────────────────────────────────────────────────────

export interface ToolRegistry {
  register(tool: Tool): void;
  remove(name: string): void;
  resolve(name: string): Tool | null;
  list(): readonly Tool[];
  removeByPlugin(pluginName: string): void;
}

// ── Pipeline events ─────────────────────────────────────────────────────────────

/**
 * The streaming output of a single turn. Every event carries the `traceId` of the turn that
 * produced it — that is the correlation key a frontend uses to route events to the right
 * message/bubble (see `SessionRunner`). A turn ends with exactly one terminal event:
 * `done` (completed), `aborted` (interrupted mid-flight), or `error`. `cancelled` is emitted
 * for a queued submission that was dropped before it ever ran (e.g. by `SessionRunner.abort`),
 * so it carries no session — there is nothing to persist.
 */
export type PipelineEvent =
  | { type: 'text-delta';     delta: string;          traceId: string }
  | { type: 'thinking';       delta: string;          traceId: string }
  | { type: 'tool:start';     callId: string; name: string; input: unknown; traceId: string }
  | { type: 'tool:stdout';    callId: string; chunk: string;  traceId: string }
  | { type: 'tool:stderr';    callId: string; chunk: string;  traceId: string }
  | { type: 'tool:end';       callId: string; result: unknown; isError: boolean; traceId: string }
  | { type: 'file';           handle: FileHandle;     traceId: string }
  | { type: 'usage';          inputTokens: number; outputTokens: number; costUsd?: number; cacheReadTokens?: number; cacheCreationTokens?: number; traceId: string }
  | { type: 'done';           session: Session;       traceId: string }
  | { type: 'aborted';        reason: string; session: Session; traceId: string }
  | { type: 'cancelled';      sessionId: string;      traceId: string }
  // A queued (not-yet-running) submission, carried on the stream so a frontend renders it as part
  // of the live "delta" (everything after the last committed message), never from stored state.
  // `queued` is the number of submissions ahead of it (0 ⇒ about to run). Emitted live on enqueue
  // and replayed (in queue order) to anyone subscribing mid-flight.
  | { type: 'queued';         content: MessageContent[]; queued: number; concatQueue: boolean; traceId: string }
  | { type: 'robo-user';      content: MessageContent[]; traceId: string }
  | { type: 'error';          error: string;          traceId: string }
  | { type: 'system-context'; text: string;           traceId: string };

// ── Session runner ──────────────────────────────────────────────────────────────

/**
 * A view onto a session returned by `SessionRunner.open`. `session` is the authoritative
 * server-side state — committed messages plus an overlay of any queued-but-not-yet-run
 * submissions (each carrying `metadata.pending: true`). `events` is a lazy, per-session live
 * tap: accessing it subscribes to the turn event stream from now (replaying the in-flight
 * turn, if any); never touching it costs nothing.
 */
export interface SessionView {
  session:        Session;
  /** Submissions waiting behind the current turn (does not count the running turn). */
  queued:         number;
  /** Correlation id of the submission this call enqueued — present only when content was supplied. */
  traceId?:       string;
  readonly events: AsyncIterable<PipelineEvent>;
}

/** Observe a session without submitting anything. */
export interface OpenOpts {
  sessionId: string;
  signal:    AbortSignal;
  /** Optional caller-supplied correlation id; one is generated when absent. */
  traceId?:  string;
}

/** Observe a session AND enqueue a submission. The compiler enforces provider/principal here;
 *  a remote frontend deserializing a request body must still validate the wire input itself. */
export interface SubmitOpenOpts extends OpenOpts {
  content:      MessageContent[];
  provider:     string;
  principal:    Principal;
  /** When true, this submission may be merged with others drained in the same batch. Default false
   *  (queue mode: one turn per submission). */
  concatQueue?: boolean;
  /** Interactive prompt implementation for this submission's turn. The frontend owns delivery —
   *  it must target the frontend's per-session client connections, not a single request. */
  prompt?:      PromptFn;
}

/**
 * Serialises turns per session. A submission never executes concurrently with another for the
 * same session; the in-memory queue (lost on process restart, by design) absorbs anything that
 * arrives mid-turn. The server is the source of truth: a frontend renders whatever `open()`
 * returns and treats the live `events` stream purely as an optimisation.
 */
export interface SessionRunner {
  open(opts: OpenOpts | SubmitOpenOpts): Promise<SessionView>;
  /** Abort the running turn (if any) and drop all queued submissions, emitting `cancelled` for each. */
  abort(sessionId: string): void;
  /** Abandon the running turn (if any) WITHOUT touching the queue — `pump` advances to the next
   *  queued submission, or idles. The "give up on this turn" path (a prompt cancel); contrast
   *  `abort`, which also clears the queue. A no-op if nothing is running. */
  cancelTurn(sessionId: string): void;
  /** Snapshot of a session's live state: whether a turn is running and how many submissions wait
   *  behind it. `busy` is `running || queued > 0`. */
  status(sessionId: string): { busy: boolean; running: boolean; queued: number };
}
