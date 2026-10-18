// OPEN ISSUES — this adapter is a prototype, and two problems are understood but not yet addressed.
//
// 1. Every call re-reads the whole conversation. matbot hands an adapter the full history each time,
//    and the Prompt API is session-based, so `stream` clones the base session (system prompt + tool
//    declarations, the one part reused) and appends every message again before prompting. On-device,
//    that prefill is most of the latency, and it grows with every turn and every tool round.
//
//    Approach: keep the session after a call with a fingerprint of what it holds (each message as
//    converted, plus the reply the model actually produced), and when the next call's converted history
//    starts with that fingerprint, append only the new tail; otherwise rebuild as now. Behind a
//    `parameters` switch so the two can be compared. Pitfalls, all of which the check must survive:
//    - Compare converted CONTENT, never message ids. The runner folds ephemeral context onto the last
//      message, so it moves from the user message (round 1) to the tool result (round 2) under the same id.
//    - Fingerprint the reply as produced, not as stored: a retract, `session_edit`, compaction or an
//      aborted stream all make the stored transcript diverge from what the session saw.
//    - One adapter serves several callers (a trigger classifier, `single_turn`) with different histories;
//      a single kept session would be evicted on every call, so it wants a small LRU pool.
//    - A kept session is checked out while prompted; a concurrent call gets its own clone.
//    - Context overflow evicts inside the session, but the fingerprint describes the logical
//      conversation, which is what the comparison needs — no special case.
//
// 2. The context window is small (a few thousand tokens for Gemini Nano). The system context and the tool
//    declarations alone can fill it before any conversation does.
//
//    Approaches, in the order worth trying:
//    - Offer fewer tools per turn: `tool-router` bounds the window, or `parameters.tools: false`.
//    - A cumulative summary of older turns, but NOT here. Summarised inside the adapter, the model would
//      answer from text that is in no session — matbot's record — and `determine_provenance` would find
//      claims with nothing behind them. The place is a `contribute` hook (it transforms the outgoing copy
//      per provider call), enabled for small-window providers, storing its summary as a marker so it is
//      durable and visible. Costs: the summary is written by the same small model, out of the same
//      window, and summaries of summaries drift; and every change to it rewrites the history's prefix,
//      defeating (1) — so summarise in fixed chunks, keeping the prefix stable between updates.

import type { ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus } from '@matatbread/matbot-plugin-api';
import { mediaIn, systemText, toPromptMessages, toToolDecls, type Modes } from './convert.js';
import {
  callIdOf, languageModel, toolCtors,
  type Expected, type LMCreateOptions, type LMMessage, type LMSession, type LanguageModelStatic,
  type SamplingMode, type ThinkingEffort,
} from './prompt-api.js';

const NO_API = 'The Prompt API (LanguageModel) is not available in this browser — it needs a Chromium build '
  + 'with built-in AI enabled (Chrome: chrome://flags/#prompt-api-for-gemini-nano, or an origin trial token).';

// `LanguageModel` existing says only that the API surface is enabled; whether a model can run is a
// separate gate, and Chrome answers "unavailable" for all of its reasons alike — so this lists them
// rather than guessing one. The flag is the commonest, and announces itself in the console.
const UNAVAILABLE = 'prompt-api: the browser reports its on-device model as "unavailable". The API is present, '
  + 'so this is the model side: in Chrome, check chrome://flags/#optimization-guide-on-device-model is Enabled '
  + '(console: "The feature flag gating model execution was disabled" means it is not), relaunch, and see '
  + 'chrome://on-device-internals for the model\'s status and whether this device meets its hardware and '
  + 'free-disk requirements.';

const SAMPLING_MODES: ReadonlySet<string> = new Set<SamplingMode>([
  'most-predictable', 'predictable', 'slightly-predictable', 'balanced', 'slightly-creative', 'creative', 'most-creative',
]);
const EFFORTS: ReadonlySet<string> = new Set<ThinkingEffort>(['none', 'low', 'medium', 'high']);

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string') ? v : undefined;
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

function contextUsage(s: LMSession): number | undefined {
  return s.contextUsage ?? s.inputUsage;
}
function contextWindow(s: LMSession): number | undefined {
  return s.contextWindow ?? s.inputQuota;
}

/**
 * The browser's own on-device model, through the Prompt API (`LanguageModel`) — Gemini Nano in Chrome.
 * No endpoint, no key, no network after the one-off model download.
 *
 * matbot adapters are stateless (every call carries the whole history) and the Prompt API is
 * session-based, so each call is a fresh session built from that history. What does not change between
 * calls — the system prompt, the tool declarations, the expected modalities — is a *base* session,
 * created once per distinct configuration and `clone()`d per call, so the part of the prefill that is
 * usually the largest is paid once. The history is then `append`ed a message at a time rather than in
 * one block: an append that overflows the context window evicts the oldest turns (keeping the system
 * prompt), whereas one block larger than the window simply fails.
 */
export class PromptApiAdapter implements ProviderAdapter {
  readonly name = 'prompt-api';

  // Only a YES is remembered. A no can be transient — Chrome answers "unavailable" for every probe while
  // its model service is still starting — and remembering one turned a startup race into "this browser
  // has no tool use" for the rest of the page's life.
  private readonly confirmed = new Set<string>();
  private base: { key: string; session: Promise<LMSession> } | undefined;
  private warnedNoTools: string | undefined;

  complete(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    return this.stream(messages, config, tools, signal);
  }

  private async supports(api: LanguageModelStatic, opts: Parameters<LanguageModelStatic['availability']>[0]): Promise<boolean> {
    const key = JSON.stringify(opts);
    if (this.confirmed.has(key)) return true;
    // An older build rejects an expected type it has never heard of (`tool-call`, `thought`) as a
    // TypeError rather than answering "unavailable" — which is the same answer.
    const ok = await api.availability(opts).then(a => a !== 'unavailable', () => false);
    if (ok) this.confirmed.add(key);
    return ok;
  }

  // Chrome asks for an output language on every request ("to properly attest to output safety") and
  // warns without one. Configured wins; otherwise the page's language, falling back to English when the
  // model does not offer it — the language is an attestation and download hint, not a translation.
  private async textExpectation(api: LanguageModelStatic, configured: string[] | undefined): Promise<Expected> {
    if (configured) {
      const text: Expected = { type: 'text', languages: configured };
      if (await api.availability({ expectedInputs: [text], expectedOutputs: [text] }) === 'unavailable')
        throw new Error(`${UNAVAILABLE} (Or a configured language, ${configured.join(', ')}, is unsupported.)`);
      return text;
    }
    const page = typeof navigator !== 'undefined' ? navigator.language.split('-')[0] : undefined;
    for (const lang of new Set([page, 'en'])) {
      if (!lang) continue;
      const text: Expected = { type: 'text', languages: [lang] };
      if (await api.availability({ expectedInputs: [text], expectedOutputs: [text] }) !== 'unavailable') return text;
    }
    throw new Error(UNAVAILABLE);
  }

  private async *stream(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    const api = languageModel();
    if (!api) throw new Error(NO_API);

    const params    = config.parameters ?? {};
    const languages = stringArray(params['languages']);
    const sampling  = typeof params['samplingMode'] === 'string' && SAMPLING_MODES.has(params['samplingMode'])
      ? params['samplingMode'] as SamplingMode : undefined;
    const effort    = typeof params['thinkingEffort'] === 'string' && EFFORTS.has(params['thinkingEffort'])
      ? params['thinkingEffort'] as ThinkingEffort : undefined;
    // Asked first and fresh, because every capability probe below answers "no" when the model itself is
    // unavailable — which then reads as "this browser lacks tool use" rather than the real cause.
    const text = await this.textExpectation(api, languages);

    const wantTools = tools.length > 0 && params['tools'] !== false;
    const ctors     = wantTools ? toolCtors() : undefined;
    const toolsOk   = ctors !== undefined && await this.supports(api, {
      expectedInputs:  [text, { type: 'tool-call' }, { type: 'tool-response' }],
      expectedOutputs: [text, { type: 'tool-call' }],
    });
    // Says which test failed: a missing constructor is the build lacking the feature outright, while a
    // refusal from `availability` may be the model (or its service) and can change on a later turn.
    const noTools = !wantTools || toolsOk ? undefined
      : ctors === undefined ? 'this build has no LanguageModelToolCall/ToolSuccess/ToolError constructors'
      : 'availability() refuses expectedOutputs "tool-call"';
    if (noTools && noTools !== this.warnedNoTools)
      console.warn(`[prompt-api] no open-loop tool use (${noTools}); running text-only, with earlier tool calls folded into the history as notes.`);
    this.warnedNoTools = noTools;

    const media    = mediaIn(messages);
    const image    = media.image && await this.supports(api, { expectedInputs: [text, { type: 'image' }] });
    const audio    = media.audio && await this.supports(api, { expectedInputs: [text, { type: 'audio' }] });
    const thoughts = effort !== undefined && effort !== 'none'
      && await this.supports(api, { thinkingEffort: effort, expectedOutputs: [text, { type: 'thought' }] });
    const modes: Modes = { tools: toolsOk ? ctors : undefined, image, audio };

    const system = systemText(messages);
    const create: LMCreateOptions = {
      ...(system ? { initialPrompts: [{ role: 'system', content: [{ type: 'text', value: system }] }] } : {}),
      expectedInputs: [
        text,
        ...(image ? [{ type: 'image' } as const] : []),
        ...(audio ? [{ type: 'audio' } as const] : []),
        ...(modes.tools ? [{ type: 'tool-call' } as const, { type: 'tool-response' } as const] : []),
      ],
      expectedOutputs: [
        text,
        ...(modes.tools ? [{ type: 'tool-call' } as const] : []),
        ...(thoughts    ? [{ type: 'thought' }   as const] : []),
      ],
      ...(modes.tools ? { tools: toToolDecls(tools) } : {}),
      ...(sampling ? { samplingMode: sampling } : {}),
      ...(thoughts && effort ? { thinkingEffort: effort } : {}),
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(typeof params['topK'] === 'number' ? { topK: params['topK'] } : {}),
    };

    const history = toPromptMessages(messages, modes);
    const final   = history.pop();
    if (!final) throw new Error('prompt-api: nothing to send — the history has no user or assistant content');
    // A trailing assistant message is a continuation: prefill it rather than ask for a new reply.
    const input: LMMessage[] = [final.role === 'assistant' ? { ...final, prefix: true } : final];

    let session: LMSession | undefined;
    const received: unknown[] = [];
    const onOverflow = (): void => console.warn(
      `[prompt-api] the conversation overflowed the on-device context window (${session ? contextWindow(session) : '?'} tokens); the oldest turns were dropped.`);
    try {
      const base = yield* this.baseSession(api, create, signal);
      session = await base.clone({ signal });
      session.addEventListener('contextoverflow', onOverflow);
      session.addEventListener('quotaoverflow', onOverflow);
      for (const m of history) await session.append([m], { signal });

      const before = contextUsage(session);
      let thought = '';
      for await (const chunk of session.promptStreaming(input, { signal })) {
        received.push(chunk);
        if (typeof chunk === 'string') {
          if (chunk) yield { type: 'text-delta', delta: chunk };
          continue;
        }
        switch (chunk.type) {
          case 'text':
            if (chunk.value) yield { type: 'text-delta', delta: chunk.value };
            break;
          case 'thought':
            thought += chunk.value;
            yield { type: 'thinking', delta: chunk.value };
            break;
          case 'tool-call':
            yield {
              type:  'tool-call',
              id:    callIdOf(chunk.value) || `call_${crypto.randomUUID()}`,
              name:  chunk.value.name,
              input: chunk.value.arguments ?? {},
            };
            break;
          default: {
            const raw = chunk as { type?: unknown };
            yield { type: 'unknown-block', blockType: String(raw.type), raw };
          }
        }
      }
      // Unsigned: the API strips thoughts from its own session after each turn, so there is nothing to
      // round-trip, and a `reasoning` block is the shape every adapter already elides from history.
      if (thought) yield { type: 'reasoning-block', reasoning: thought };

      // There is no per-call token report — only the session's running total — so the comparable
      // counters are differences of it. `before` covers the system prompt, tools and history; the rest
      // is the final input plus the reply, which cannot be told apart without a second tokenisation.
      const after = contextUsage(session);
      if (before !== undefined && after !== undefined) {
        const window = contextWindow(session);
        yield {
          type:         'usage',
          inputTokens:  before,
          outputTokens: Math.max(0, after - before),
          reported:     { contextUsageBefore: before, contextUsageAfter: after, ...(window !== undefined ? { contextWindow: window } : {}) },
        };
      }
      yield { type: 'done' };
    } catch (e) {
      throw explain(e, session, modes.tools ? tools.length : 0);
    } finally {
      // The exchange exactly as the API saw it, at the level DevTools hides unless "Verbose" is on — the
      // only way to tell a small model's answer from one this adapter garbled.
      console.debug('[prompt-api] exchange', { create, history, input, received });
      if (session) {
        session.removeEventListener('contextoverflow', onOverflow);
        session.removeEventListener('quotaoverflow', onOverflow);
        session.destroy();
      }
    }
  }

  // One base session per distinct (system, tools, modalities, sampling) — replaced, not accumulated,
  // when the configuration moves on, since each holds a loaded model context. Progress is only shown to
  // the call that started a real download: the API fires a 0 and a 1 event even when nothing downloads.
  private async *baseSession(
    api:    LanguageModelStatic,
    opts:   LMCreateOptions,
    signal: AbortSignal,
  ): AsyncGenerator<CompletionEvent, LMSession> {
    const key = JSON.stringify(opts);
    if (this.base?.key === key) return await untilAborted(this.base.session, signal);

    const state = await api.availability({
      ...(opts.expectedInputs  ? { expectedInputs:  opts.expectedInputs }  : {}),
      ...(opts.expectedOutputs ? { expectedOutputs: opts.expectedOutputs } : {}),
      ...(opts.thinkingEffort  ? { thinkingEffort:  opts.thinkingEffort }  : {}),
    });
    // Text alone was available (checked in `stream`), so it is a requested modality the model lacks.
    if (state === 'unavailable')
      throw new Error(`prompt-api: the on-device model cannot take this combination of inputs/outputs: ${JSON.stringify({ in: opts.expectedInputs, out: opts.expectedOutputs })}`);
    const downloading = state !== 'available';

    const progress: number[] = [];
    let wake = (): void => {};
    const created = api.create({
      ...opts,
      monitor: m => m.addEventListener('downloadprogress', e => { progress.push((e as ProgressEvent).loaded); wake(); }),
    });
    const prev = this.base;
    const mine = { key, session: created };
    this.base = mine;
    void prev?.session.then(s => s.destroy(), () => {});
    created.catch(() => { if (this.base === mine) this.base = undefined; });

    // The platform reports progress through a callback; bridged here onto the event stream so the user
    // sees a multi-gigabyte first download as it happens. Download done is not ready: the model then
    // loads, which is said rather than leaving a finished bar looking stuck.
    let settled = false;
    created.then(() => { settled = true; wake(); }, () => { settled = true; wake(); });
    const onAbort = (): void => wake();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!settled && !signal.aborted) {
        await new Promise<void>(r => { wake = r; if (settled || progress.length > 0 || signal.aborted) r(); });
        const loaded = progress.splice(0).at(-1);
        if (downloading && loaded !== undefined)
          yield {
            type:    'progress',
            pct:     Math.round(loaded * 100),
            message: loaded < 1 ? 'Downloading the on-device model' : 'Loading the on-device model',
          };
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    signal.throwIfAborted();
    try {
      return await created;
    } catch (e) {
      // Chrome's own reason ("the service is not running") goes to the console, not into the rejection,
      // so the one useful fact to add here is what availability claimed just before.
      if (e instanceof DOMException && e.name !== 'AbortError' && e.name !== 'NotAllowedError' && e.name !== 'QuotaExceededError')
        throw new Error(`prompt-api: the browser could not start a model session (${e.name}: ${e.message}) although it reported `
          + `availability "${state}". Check the browser console for its reason, and chrome://on-device-internals for the `
          + 'model\'s status — a model still downloading or loading after a flag change usually clears on its own.', { cause: e });
      throw e;
    }
  }

  async health(): Promise<HealthStatus> {
    const api = languageModel();
    if (!api) return { status: 'down', reason: NO_API };
    let state: string;
    const text: Expected = { type: 'text', languages: ['en'] };
    try { state = await api.availability({ expectedInputs: [text], expectedOutputs: [text] }); } catch (e) {
      return { status: 'down', reason: e instanceof Error ? e.message : String(e) };
    }
    switch (state) {
      case 'available':    return { status: 'ok' };
      case 'downloadable': return { status: 'degraded', reason: 'model not downloaded yet; the first message starts the download' };
      case 'downloading':  return { status: 'degraded', reason: 'model downloading' };
      case 'unavailable':  return { status: 'down', reason: UNAVAILABLE };
      default:             return { status: 'degraded', reason: `unrecognised availability "${state}"` };
    }
  }
}

// The platform's errors are DOMExceptions named for the condition, with messages written for a web
// developer. Restated where the remedy is a matbot one; everything else, an abort included, passes through.
function explain(e: unknown, session: LMSession | undefined, toolCount: number): unknown {
  const name = e instanceof DOMException ? e.name : undefined;
  if (name === 'QuotaExceededError') {
    const window = session ? contextWindow(session) : undefined;
    return new Error(
      `prompt-api: the system prompt${toolCount ? ` and ${toolCount} tool declarations` : ''} do not fit the on-device `
      + `context window${window !== undefined ? ` (${window} tokens)` : ''}. Load the tool-router plugin to bound the tools `
      + 'offered per turn, or set `parameters.tools: false` on this provider.', { cause: e });
  }
  if (name === 'NotAllowedError')
    return new Error('prompt-api: the browser refused to start the model download — Chrome only allows it from a user '
      + 'gesture, so send a message from the page (not a trigger or background job) to begin it.', { cause: e });
  return e;
}
