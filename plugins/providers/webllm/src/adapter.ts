import type { ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus } from '@matatbread/matbot-plugin-api';
import { ReplyParser, toChatMessages, toolCallFormat, type Piece } from './format.js';
import { DEFAULT_LIBRARY, cacheBackend, checkModel, library, loadEngine, type CacheBackend, type ChatRequest, type InitProgressReport, type Loaded } from './webllm.js';

export const DEFAULT_MODEL = 'Qwen3-4B-q4f16_1-MLC';
// WebLLM's prebuilt Qwen3 records cap the window at 4096, which matbot's system context and a tool list
// alone can fill. 8192 costs roughly another 0.6 GB of GPU memory for a 4B model; `contextWindow` changes it.
const DEFAULT_CONTEXT = 8192;

const NO_WEBGPU = 'webllm: this browser has no WebGPU (navigator.gpu), which WebLLM needs to run a model. '
  + 'Chrome and Edge have it on most desktops; elsewhere check chrome://gpu or the browser\'s WebGPU flag.';

interface Slot {
  key:     string;
  loaded:  Promise<Loaded>;
  holders: number;
  retired: boolean;
}

// One model resident at a time, shared by every provider profile using this adapter: two engines would
// hold two models' weights in GPU memory, which is the resource this provider is shortest of. A different
// model or window replaces it, but the old engine is unloaded only once no call is still using it.
let slot: Slot | undefined;

// What the provider last loaded, for `webllm_models`: the library and cache it must read through to see the
// same models and downloads, and the model resident now (absent once replaced). Remembered past an unload,
// since a profile's own `library`/`cache` still applies to its next call.
let lastLoaded: { library: string; cache: CacheBackend | undefined } | undefined;

export function resident(): { library: string; cache: CacheBackend | undefined; model?: string } {
  const model = slot && !slot.retired ? (JSON.parse(slot.key) as unknown[])[1] : undefined;
  return {
    ...(lastLoaded ?? { library: DEFAULT_LIBRARY, cache: cacheBackend(undefined) }),
    ...(typeof model === 'string' ? { model } : {}),
  };
}

function unload(s: Slot): void {
  void s.loaded.then(({ engine, worker }) => engine.unload().finally(() => worker?.terminate()), () => {});
}

function release(s: Slot): void {
  s.holders--;
  if (s.retired && s.holders === 0) unload(s);
}

function gpu(): { requestAdapter(): Promise<unknown> } | undefined {
  return typeof navigator === 'undefined' ? undefined
    : (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
}

/**
 * Open-weight models run in the page on the GPU through WebLLM — Qwen3 by default — loaded from a CDN on
 * first use, so the library costs nothing to an install that never picks this provider. No endpoint, no
 * key, no network after the model is cached.
 *
 * `model` is a WebLLM model id (`Qwen3-8B-q4f16_1-MLC`, `Llama-3.2-3B-Instruct-q4f16_1-MLC`, …). Tool calling
 * is this adapter's own, in Qwen's `<tool_call>` format (see format.ts), so it is reliable only on models
 * trained on that format: Qwen and Hermes.
 */
export class WebLLMAdapter implements ProviderAdapter {
  readonly name = 'webllm';

  complete(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    return this.stream(messages, config, tools, signal);
  }

  private async *stream(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    if (!gpu()) throw new Error(NO_WEBGPU);
    const params        = config.parameters ?? {};
    const model         = config.model || DEFAULT_MODEL;
    const libraryUrl    = typeof params['library'] === 'string' ? params['library'] : DEFAULT_LIBRARY;
    const contextWindow = typeof params['contextWindow'] === 'number' ? params['contextWindow'] : DEFAULT_CONTEXT;
    const offered       = params['tools'] === false ? [] : tools;
    const cache         = cacheBackend(params['cache']);

    const chat = toChatMessages(messages, offered);
    const last = chat.at(-1);
    if (!last || last.role !== 'user')
      throw new Error('webllm: the conversation must end with a user turn or a tool result — WebLLM cannot continue an assistant message.');

    const request: ChatRequest = {
      messages:       chat,
      stream:         true,
      stream_options: { include_usage: true },
      ...(typeof params.maxTokens   === 'number' ? { max_tokens:  params.maxTokens }   : {}),
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(typeof params.topP        === 'number' ? { top_p:       params.topP }        : {}),
      ...(params.stopSequences ? { stop: params.stopSequences } : {}),
      ...(offered.length > 0 ? { response_format: toolCallFormat(offered) } : {}),
      // Qwen3 reasons before every answer unless told not to, which on a laptop GPU is most of the wait.
      extra_body: { enable_thinking: params['thinking'] === true },
    };

    const held = yield* this.acquire(libraryUrl, model, contextWindow, cache, signal);
    const raw: string[] = [];
    let finish: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const { engine } = await held.loaded;
      onAbort = (): void => void engine.interruptGenerate();
      signal.addEventListener('abort', onAbort, { once: true });
      const parser = new ReplyParser();
      let reasoning = '';
      const events = function* (pieces: Piece[]): Generator<CompletionEvent> {
        for (const p of pieces) {
          switch (p.kind) {
            case 'text':     yield { type: 'text-delta', delta: p.text }; break;
            case 'thinking': reasoning += p.text; yield { type: 'thinking', delta: p.text }; break;
            case 'call':     yield { type: 'tool-call', id: `call_${crypto.randomUUID()}`, name: p.name, input: p.arguments }; break;
            case 'cut-call':
              yield { type: 'tool-call', id: `call_${crypto.randomUUID()}`, name: p.name, input: {},
                truncated: { bytes: p.bytes, ...(finish ? { stopReason: finish } : {}) } };
              break;
          }
        }
      };

      for await (const chunk of await engine.chat.completions.create(request)) {
        const choice = chunk.choices[0];
        const delta  = choice?.delta.content;
        if (delta) { raw.push(delta); yield* events(parser.push(delta)); }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
      signal.throwIfAborted();
      yield* events(parser.end());
      if (reasoning) yield { type: 'reasoning-block', reasoning };
      if (usage) {
        yield {
          type:         'usage',
          inputTokens:  typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0,
          outputTokens: typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0,
          reported:     { ...usage },
        };
      }
      if (finish === 'length') yield { type: 'truncated', reason: 'max-tokens', raw: finish };
      yield { type: 'done' };
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      // What the model was sent and what it wrote, verbatim, at the level DevTools hides unless "Verbose".
      console.debug('[webllm] exchange', { model, request, reply: raw.join(''), finish, usage });
      release(held);
    }
  }

  // The caller owns one `release`, here on success and inside on any failure — including abandoning the
  // iteration during a progress event, which runs `finally` but no `catch`. Progress goes to the call that
  // started the load; any other waits on the same promise.
  private async *acquire(
    libraryUrl:    string,
    model:         string,
    contextWindow: number,
    cache:         CacheBackend | undefined,
    signal:        AbortSignal,
  ): AsyncGenerator<CompletionEvent, Slot> {
    const key = JSON.stringify([libraryUrl, model, contextWindow, cache]);
    if (slot && slot.key === key) {
      const s = slot;
      s.holders++;
      let ok = false;
      try {
        await untilAborted(s.loaded, signal);
        ok = true;
        return s;
      } finally {
        if (!ok) release(s);
      }
    }

    // Before the slot changes hands: a request naming a model that cannot run must not unload the one that can.
    await checkModel(await library(libraryUrl), model);
    lastLoaded = { library: libraryUrl, cache };
    const reports: InitProgressReport[] = [];
    let wake = (): void => {};
    const loaded = loadEngine(libraryUrl, model, contextWindow, cache, r => { reports.push(r); wake(); });
    const mine: Slot = { key, loaded, holders: 1, retired: false };
    const previous = slot;
    slot = mine;
    if (previous) {
      previous.retired = true;
      if (previous.holders === 0) unload(previous);
    }
    loaded.catch(() => { mine.retired = true; if (slot === mine) slot = undefined; });

    let settled = false;
    loaded.then(() => { settled = true; wake(); }, () => { settled = true; wake(); });
    const onAbort = (): void => wake();
    signal.addEventListener('abort', onAbort, { once: true });
    let ok = false;
    try {
      while (!settled && !signal.aborted) {
        await new Promise<void>(r => { wake = r; if (settled || reports.length > 0 || signal.aborted) r(); });
        const report = reports.splice(0).at(-1);
        if (report) {
          console.debug('[webllm] load', report.text);
          yield {
            type:    'progress',
            pct:     Math.round(report.progress * 100),
            message: `${report.text.startsWith('Fetching') ? 'Downloading' : 'Loading'} ${model}`,
          };
        }
      }
      signal.throwIfAborted();
      await loaded;
      ok = true;
      return mine;
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (!ok) release(mine);
    }
  }

  async health(): Promise<HealthStatus> {
    const g = gpu();
    if (!g) return { status: 'down', reason: NO_WEBGPU };
    try {
      return (await g.requestAdapter()) ? { status: 'ok' } : { status: 'down', reason: 'WebGPU is present but offered no GPU adapter.' };
    } catch (e) {
      return { status: 'down', reason: e instanceof Error ? e.message : String(e) };
    }
  }
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}
