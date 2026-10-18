// The slice of the Prompt API (https://github.com/webmachinelearning/prompt-api) this adapter uses.
// TypeScript's DOM lib does not declare it yet, and a `declare global` here would collide with
// `@types/dom-chromium-ai` in any program that also loads that, so it is local and reached through
// `globalThis`. Everything is optional-at-runtime: the API is experimental, Chrome ships parts of it
// behind flags and origin trials, and the names have already been renamed once.

export type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export type ExpectedType = 'text' | 'image' | 'audio' | 'tool-call' | 'tool-response' | 'thought';
export interface Expected { type: ExpectedType; languages?: string[] }

// Chromium spelt it `callID` until 2026-10-01 ("Rename "callID" to "callId" in Prompt API tool use"), and
// an init dictionary requires whichever its build knows. So both are written — a dictionary ignores a
// member it does not declare — and a model's call is read under either; see `callIds` / `callIdOf`.
interface CallIds { callId: string; callID?: string }
export interface LMToolCall    extends CallIds { name: string; arguments: Record<string, unknown> }
export interface LMToolSuccess extends CallIds { name: string; result: LMToolResultContent[] }
export interface LMToolError   extends CallIds { name: string; errorMessage: string }

export function callIds(id: string): Required<CallIds> {
  return { callId: id, callID: id };
}

export function callIdOf(call: Partial<CallIds>): string | undefined {
  return call.callId ?? call.callID;
}

export type LMToolResultContent =
  | { type: 'text';   value: string }
  | { type: 'object'; value: object };

export type LMContent =
  | { type: 'text';          value: string }
  | { type: 'image';         value: Blob }
  | { type: 'audio';         value: Blob }
  | { type: 'tool-call';     value: LMToolCall }
  | { type: 'tool-response'; value: LMToolSuccess | LMToolError };

export interface LMMessage {
  role:    'system' | 'user' | 'assistant';
  content: LMContent[];
  prefix?: boolean;
}

export type LMOutputChunk =
  | { type: 'text';      value: string }
  | { type: 'thought';   value: string }
  | { type: 'tool-call'; value: LMToolCall };

export interface LMToolDecl { name: string; description: string; inputSchema: object }

export type SamplingMode =
  | 'most-predictable' | 'predictable' | 'slightly-predictable' | 'balanced'
  | 'slightly-creative' | 'creative' | 'most-creative';
export type ThinkingEffort = 'none' | 'low' | 'medium' | 'high';

export interface LMCreateOptions {
  initialPrompts?:  LMMessage[];
  expectedInputs?:  Expected[];
  expectedOutputs?: Expected[];
  tools?:           LMToolDecl[];
  samplingMode?:    SamplingMode;
  thinkingEffort?:  ThinkingEffort;
  // Deprecated, honoured only in extension contexts; a web page gets a console warning and no effect.
  temperature?:     number;
  topK?:            number;
  signal?:          AbortSignal;
  monitor?(m: EventTarget): void;
}

export interface LMPromptOptions { signal?: AbortSignal; thinkingEffort?: ThinkingEffort }

export interface LMSession extends EventTarget {
  // Chrome's ReadableStream is async-iterable; the DOM lib in use here does not say so.
  promptStreaming(input: LMMessage[], opts?: LMPromptOptions): AsyncIterable<string | LMOutputChunk>;
  append(input: LMMessage[], opts?: { signal?: AbortSignal }): Promise<void>;
  clone(opts?: { signal?: AbortSignal }): Promise<LMSession>;
  destroy(): void;
  readonly contextUsage?:  number;
  readonly contextWindow?: number;
  // The pre-rename names, still the only ones on older builds and in extension contexts.
  readonly inputUsage?:    number;
  readonly inputQuota?:    number;
}

export interface LanguageModelStatic {
  availability(opts?: Omit<LMCreateOptions, 'initialPrompts' | 'monitor' | 'signal'>): Promise<Availability>;
  create(opts?: LMCreateOptions): Promise<LMSession>;
}

export interface ToolCtors {
  call:    new (init: LMToolCall) => LMToolCall;
  success: new (init: LMToolSuccess) => LMToolSuccess;
  error:   new (init: LMToolError) => LMToolError;
}

const g = globalThis as {
  LanguageModel?:            LanguageModelStatic;
  LanguageModelToolCall?:    ToolCtors['call'];
  LanguageModelToolSuccess?: ToolCtors['success'];
  LanguageModelToolError?:   ToolCtors['error'];
};

export function languageModel(): LanguageModelStatic | undefined {
  return g.LanguageModel;
}

// Tool content must be built with the platform's own classes — a plain `{ callId, name, arguments }`
// is not one — so their absence means the build has no open-loop tool use at all, whatever
// `availability` says.
export function toolCtors(): ToolCtors | undefined {
  const { LanguageModelToolCall: call, LanguageModelToolSuccess: success, LanguageModelToolError: error } = g;
  return call && success && error ? { call, success, error } : undefined;
}
