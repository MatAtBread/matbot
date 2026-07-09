import type { ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus } from '@matatbread/matbot-plugin-api';
import { parseSSE } from '@matatbread/matbot-core/providers-base';
import { toGeminiContents, toGeminiSystem, toGeminiTools, type GeminiPart } from './convert.js';

const DEFAULT_ENDPOINT   = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MAX_TOKENS = 4096;

// Compose the streaming request URL from the config's own fields. Native Gemini puts the model in the
// URL path (unlike the anthropic/openai wire, which carry it in the body), so the model IS interpolated
// here — from `config.model`, never a placeholder in the endpoint string. The API key is sent in the
// `x-goog-api-key` header (from `credentials.apiKey`), never the query string, so it stays out of logs.
// Accepts either a base (…/v1beta) or a full/templated native URL (…/models/{model}:generateContent?…).
function buildUrl(endpoint: string, model: string): string {
  const u = new URL(endpoint);
  u.search = '';                                               // key & any query dropped; key → header
  let path = u.pathname.replace(/\{model(_id)?\}/g, model);    // honour a templated model placeholder
  if (path.includes(':')) {
    path = path.replace(/:(stream)?generateContent\b/i, ':streamGenerateContent');  // force streaming
  } else {
    path = `${path.replace(/\/+$/, '')}/models/${model}:streamGenerateContent`;      // base → full path
  }
  u.pathname = path;
  u.searchParams.set('alt', 'sse');
  return u.toString();
}

interface GeminiChunk {
  candidates?: Array<{ content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?:        number;
    candidatesTokenCount?:    number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?:      number;
  };
  error?: { message?: string; status?: string };
}

export class GoogleAdapter implements ProviderAdapter {
  readonly name = 'google-gemini';

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
    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    const apiKey   = config.credentials?.['apiKey'] ?? '';

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: config.parameters?.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (config.parameters?.temperature !== undefined) generationConfig['temperature'] = config.parameters.temperature;
    // Gemini 3 returns thought signatures on function calls regardless; `thinking` only opts into
    // streaming the thought *text* back (stored as a signed thinking block for same-provider replay).
    if (config.parameters?.['thinking']) generationConfig['thinkingConfig'] = { includeThoughts: true };

    const body: Record<string, unknown> = {
      contents:         toGeminiContents(messages, config.name),
      generationConfig,
    };
    const system = toGeminiSystem(messages);
    if (system) body['systemInstruction'] = system;
    const toolDefs = toGeminiTools(tools);
    if (toolDefs.length > 0) body['tools'] = toolDefs;

    const res = await fetch(buildUrl(endpoint, config.model), {
      method:  'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body:    JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Google ${res.status}: ${text}`);
    }

    // Gemini streams `text` deltas across chunks but delivers each `functionCall` complete in one part,
    // so tool calls are yielded on sight. Thought text is accumulated into a single signed block flushed
    // at the end. usageMetadata is cumulative and repeats per chunk, so only the final tally is emitted
    // (the runner sums usage events — emitting each would over-count).
    let thinkingAcc = '';
    let thinkingSig = '';
    let lastUsage: GeminiChunk['usageMetadata'];
    let sawAny     = false;
    let lastFinish: string | undefined;

    for await (const line of parseSSE(res.body)) {
      let chunk: GeminiChunk;
      try { chunk = JSON.parse(line) as GeminiChunk; } catch { continue; }

      if (chunk.error) throw new Error(`Google stream error: ${chunk.error.message ?? chunk.error.status ?? 'unknown'}`);
      if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;

      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) lastFinish = cand.finishReason;

      for (const part of cand?.content?.parts ?? []) {
        if (part.functionCall) {
          sawAny = true;
          const sig = part.thoughtSignature;
          yield {
            type:  'tool-call',
            id:    part.functionCall.id ?? `call_${crypto.randomUUID()}`,
            name:  part.functionCall.name,
            input: part.functionCall.args ?? {},
            ...(sig !== undefined ? { meta: { google: { thoughtSignature: sig } } } : {}),
          };
        } else if (part.thought === true && part.text) {
          sawAny = true;
          thinkingAcc += part.text;
          if (part.thoughtSignature) thinkingSig = part.thoughtSignature;
          yield { type: 'thinking', delta: part.text };
        } else if (part.text) {
          sawAny = true;
          yield { type: 'text-delta', delta: part.text };
        }
      }
    }

    if (thinkingAcc) yield { type: 'thinking-block', thinking: thinkingAcc, signature: thinkingSig };

    if (lastUsage) {
      const prompt = lastUsage.promptTokenCount ?? 0;
      const cached = lastUsage.cachedContentTokenCount ?? 0;
      yield {
        type:         'usage',
        inputTokens:  Math.max(0, prompt - cached),
        outputTokens: (lastUsage.candidatesTokenCount ?? 0) + (lastUsage.thoughtsTokenCount ?? 0),
        ...(cached > 0 ? { cacheReadTokens: cached } : {}),
      };
    }

    if (!sawAny) {
      console.warn(
        `[google] empty completion: finishReason=${lastFinish ?? '(none)'}; sent ${messages.length} messages ` +
        `(roles: ${messages.map(m => m.role).join(',')}). A 'SAFETY'/'RECITATION' finishReason means the endpoint blocked it.`,
      );
    }
    yield { type: 'done' };
  }

  async health(): Promise<HealthStatus> {
    return { status: 'ok' };
  }
}
