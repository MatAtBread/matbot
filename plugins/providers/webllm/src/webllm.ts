// The slice of WebLLM (https://github.com/mlc-ai/web-llm) this adapter uses. Declared locally rather than
// taken from the package because the package is never installed: the library is several MB, matters only
// to someone who chooses this provider, and is imported from a CDN at the moment it is first needed.

import { closestIds } from '@matatbread/matbot-plugin-api';

export interface InitProgressReport { progress: number; timeElapsed: number; text: string }

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatCompletionChunk {
  choices: Array<{
    delta:         { content?: string | null };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'abort' | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; [key: string]: unknown };
}

export interface ResponseFormat { type: 'structural_tag'; structural_tag: object }

export interface ChatRequest {
  messages:        ChatMessage[];
  stream:          true;
  stream_options:  { include_usage: true };
  max_tokens?:     number;
  temperature?:    number;
  top_p?:          number;
  stop?:           string[];
  response_format?: ResponseFormat;
  extra_body?:     { enable_thinking?: boolean };
}

export interface Engine {
  chat: { completions: { create(request: ChatRequest): Promise<AsyncIterable<ChatCompletionChunk>> } };
  interruptGenerate(): void | Promise<void>;
  unload(): Promise<void>;
}

export type CacheBackend = 'cache' | 'indexeddb' | 'opfs' | 'cross-origin';

interface ChatOptions  { context_window_size?: number }

export interface ModelRecord {
  model:                  string;
  model_id:               string;
  model_lib:              string;
  overrides?:             ChatOptions;
  vram_required_MB?:      number;
  low_resource_required?: boolean;
  required_features?:     string[];
  // WebLLM's `ModelType`: 0 an LLM, 1 an embedding model, 2 a vision-language model.
  model_type?:            number;
}

export interface AppConfig { model_list: ModelRecord[]; cacheBackend?: CacheBackend }
interface EngineConfig     { initProgressCallback?: (report: InitProgressReport) => void; appConfig?: AppConfig }

export interface WebLLM {
  prebuiltAppConfig: AppConfig;
  CreateWebWorkerMLCEngine(worker: Worker, modelId: string, config?: EngineConfig, chatOpts?: ChatOptions): Promise<Engine>;
  CreateMLCEngine(modelId: string, config?: EngineConfig, chatOpts?: ChatOptions): Promise<Engine>;
  hasModelInCache(modelId: string, appConfig?: AppConfig): Promise<boolean>;
  deleteModelAllInfoInCache(modelId: string, appConfig?: AppConfig): Promise<void>;
}

const CACHE_BACKENDS: ReadonlySet<string> = new Set<CacheBackend>(['cache', 'indexeddb', 'opfs', 'cross-origin']);

// WebLLM keeps weights in Cache Storage by default, which a page opened from `file://` — how the bundle is
// often run — cannot use; IndexedDB works there. Configured wins.
export function cacheBackend(configured: unknown): CacheBackend | undefined {
  if (typeof configured === 'string' && CACHE_BACKENDS.has(configured)) return configured as CacheBackend;
  return typeof location !== 'undefined' && location.protocol === 'file:' ? 'indexeddb' : undefined;
}

// The app config every call into the library must agree on, or a model downloaded into one cache is
// looked for in another.
export function appConfig(lib: WebLLM, cache: CacheBackend | undefined): AppConfig {
  return cache ? { ...lib.prebuiltAppConfig, cacheBackend: cache } : lib.prebuiltAppConfig;
}

// 0.2.85 (2026-09-08) rather than the newest: pinned, so a release cannot change behaviour underneath an
// install, and not the first to try a fresh one. `parameters.library` points elsewhere.
export const DEFAULT_LIBRARY = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';

const libraries = new Map<string, Promise<WebLLM>>();

export function library(url: string): Promise<WebLLM> {
  let lib = libraries.get(url);
  if (!lib) {
    lib = import(/* @vite-ignore */ url) as Promise<WebLLM>;
    libraries.set(url, lib);
    lib.catch(() => libraries.delete(url));
  }
  return lib;
}

export interface Loaded { engine: Engine; worker: Worker | undefined }

// In a worker where the page has one, so tokenising and sampling never stall the UI: a module worker built
// from a blob, since a single-file bundle has no script URL to give it, importing the same library URL.
// Without `Worker` (a test, an unusual host) the engine runs in-page.
export async function loadEngine(
  libraryUrl:    string,
  model:         string,
  contextWindow: number,
  cacheBackend:  CacheBackend | undefined,
  onProgress:    (report: InitProgressReport) => void,
): Promise<Loaded> {
  const lib = await library(libraryUrl);
  const opts: EngineConfig = { initProgressCallback: onProgress, appConfig: appConfig(lib, cacheBackend) };
  const chat = { context_window_size: contextWindow };
  if (typeof Worker === 'undefined') return { engine: await lib.CreateMLCEngine(model, opts, chat), worker: undefined };

  const src = `import { WebWorkerMLCEngineHandler } from ${JSON.stringify(libraryUrl)};\n`
    + 'const handler = new WebWorkerMLCEngineHandler();\n'
    + 'self.onmessage = (msg) => handler.onmessage(msg);\n';
  const url    = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const worker = new Worker(url, { type: 'module' });
  try {
    return { engine: await lib.CreateWebWorkerMLCEngine(worker, model, opts, chat), worker };
  } catch (e) {
    worker.terminate();
    throw e;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let features: Promise<ReadonlySet<string> | undefined> | undefined;

// What this page's GPU offers, asked once: the one capability WebLLM's records name is `shader-f16`, which
// every q4f16 build needs. Undefined where there is no adapter to ask.
export function gpuFeatures(): Promise<ReadonlySet<string> | undefined> {
  features ??= (async () => {
    const gpu = typeof navigator === 'undefined' ? undefined
      : (navigator as { gpu?: { requestAdapter(): Promise<{ features: ReadonlySet<string> } | null> } }).gpu;
    const adapter = await gpu?.requestAdapter().catch(() => null);
    return adapter ? new Set(adapter.features) : undefined;
  })();
  return features;
}

// Every LLM the library can run, i.e. not its embedding models.
export function chatModels(lib: WebLLM): ModelRecord[] {
  return lib.prebuiltAppConfig.model_list.filter(r => r.model_type !== 1);
}

// The families trained on the tool format this adapter speaks — `<tool_call>{"name": …, "arguments": …}`,
// the Hermes format Qwen adopted — read off each family's published chat template (and, for Hermes-3, whose
// template omits it, its model card). WebLLM records nothing of the kind: its `functionCallingModelIds` is
// about its own `tools` path, which this adapter does not use. A model outside these can still be made to
// emit a valid call by the constraint, but only once it writes `<tool_call>`, which one never trained on
// the format rarely does — it answers in prose, or invents a format of its own.
// Left out on purpose: Qwen3.5 (it calls tools in XML, `<function=…><parameter=…>`), Qwen2.5-Math (shares
// Qwen2.5's template, but is a maths specialist), Qwen2 and the DeepSeek-R1 distills (no tool format), and
// Llama 3.x and Mistral (formats of their own).
const TOOL_FAMILIES = /^(Qwen3-|Qwen2\.5-(?!Math)|Hermes-2-Pro-|Hermes-2-Theta-|Hermes-3-)/;

export function callsTools(modelId: string): boolean {
  return TOOL_FAMILIES.test(modelId);
}

// The models worth offering to matbot, which always has tools to offer.
export function toolModels(lib: WebLLM): ModelRecord[] {
  return chatModels(lib).filter(r => callsTools(r.model_id));
}

// Smallest first: on a GPU in a page, memory decides what runs at all.
export function offeredModels(lib: WebLLM): ModelRecord[] {
  return toolModels(lib).sort((a, b) =>
    (a.vram_required_MB ?? Infinity) - (b.vram_required_MB ?? Infinity) || a.model_id.localeCompare(b.model_id));
}

export function closestModels(id: string, records: readonly ModelRecord[], n = 5): string[] {
  return closestIds(id, records.map(r => r.model_id), n);
}

// Refused before anything downloads or loads: an unknown id would otherwise surface as a library error
// after the worker started, and an f16 build on a GPU without f16 as a shader failure after gigabytes.
// `withTools`: whether this call offers tools. Without them any chat model will do (`parameters.tools: false`).
export async function checkModel(lib: WebLLM, model: string, withTools: boolean): Promise<void> {
  const models = chatModels(lib);
  const record = models.find(r => r.model_id === model);
  if (!record) {
    const near = closestModels(model, withTools ? toolModels(lib) : models);
    throw new Error(`webllm: "${model}" is not a model this WebLLM build can run.`
      + (near.length > 0 ? ` Closest: ${near.join(', ')}.` : '')
      + ' The webllm_models tool lists them.');
  }
  if (withTools && !callsTools(model)) {
    const near = closestModels(model, toolModels(lib), 3);
    throw new Error(`webllm: "${model}" is not trained on the tool-call format this provider uses, so it would answer `
      + 'instead of calling tools. Use a Qwen3, Qwen2.5 or Hermes model'
      + (near.length > 0 ? ` (closest: ${near.join(', ')})` : '')
      + ', or set `parameters.tools: false` to use it for plain chat.');
  }
  const have = await gpuFeatures();
  const missing = have ? (record.required_features ?? []).filter(f => !have.has(f)) : [];
  if (missing.length > 0) {
    const f32 = model.replace('q4f16', 'q4f32');
    throw new Error(`webllm: "${model}" needs the GPU feature${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which this GPU lacks.`
      + (f32 !== model && models.some(r => r.model_id === f32) ? ` Use "${f32}" instead.` : ''));
  }
}
