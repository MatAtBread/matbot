import type { ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus } from '@matbot/plugin-api';
import { parseSSE } from '@matbot/providers-base';
import { toOAIMessages, toOAITools } from './convert.js';

const DEFAULT_ENDPOINT   = 'https://api.openai.com';
const DEFAULT_MAX_TOKENS = 4096;

interface OAIDelta {
  role?:               string;
  content?:            string | null;
  reasoning_content?:  string | null;
  tool_calls?:  Array<{
    index:    number;
    id?:      string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OAIChunk {
  choices?: Array<{ delta?: OAIDelta; finish_reason?: string | null }>;
  usage?:   { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly name: string;

  constructor(name = 'openai-compat') {
    this.name = name;
  }

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
    const apiKey   = config.credentials['apiKey'] ?? '';

    const isOpenAI = endpoint.includes('api.openai.com');
    const body: Record<string, unknown> = {
      model:      config.model,
      max_tokens: config.parameters?.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages:   toOAIMessages(messages),
      stream:     true,
      ...(isOpenAI ? { stream_options: { include_usage: true } } : {}),
    };

    const toolDefs = toOAITools(tools);
    if (toolDefs.length > 0) body['tools'] = toolDefs;

    if (config.parameters?.temperature !== undefined) {
      body['temperature'] = config.parameters.temperature;
    }

    const res = await fetch(`${endpoint}/v1/chat/completions`, {
      method:  'POST',
      headers: {
        'content-type':  'application/json',
        'authorization': `Bearer ${apiKey}`,
        ...(config.credentials['organization']
          ? { 'openai-organization': config.credentials['organization'] }
          : {}),
      },
      body:   JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`OpenAI-compat ${res.status}: ${text}`);
    }

    // Accumulate streaming tool call arguments and reasoning per index
    const toolAccum    = new Map<number, { id: string; name: string; args: string }>();
    let reasoningAcc = '';

    for await (const line of parseSSE(res.body)) {
      let chunk: OAIChunk;
      try { chunk = JSON.parse(line) as OAIChunk; } catch { continue; }

      // Usage (some providers send at end of stream)
      if (chunk.usage) {
        yield {
          type:         'usage',
          inputTokens:  chunk.usage.prompt_tokens     ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};

      if (delta.reasoning_content) {
        reasoningAcc += delta.reasoning_content;
        yield { type: 'thinking', delta: delta.reasoning_content };
      }
      if (delta.content) {
        yield { type: 'text-delta', delta: delta.content };
      }

      for (const tc of delta.tool_calls ?? []) {
        const acc = toolAccum.get(tc.index);
        if (!acc) {
          toolAccum.set(tc.index, {
            id:   tc.id   ?? '',
            name: tc.function?.name ?? '',
            args: tc.function?.arguments ?? '',
          });
        } else {
          if (tc.id)                       acc.id   = tc.id;
          if (tc.function?.name)           acc.name = tc.function.name;
          if (tc.function?.arguments)      acc.args += tc.function.arguments;
        }
      }

      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
        if (reasoningAcc) {
          yield { type: 'reasoning-block', reasoning: reasoningAcc };
          reasoningAcc = '';
        }
        for (const [, call] of toolAccum) {
          let input: unknown = {};
          try { input = JSON.parse(call.args || '{}'); } catch { /* malformed */ }
          yield { type: 'tool-call', id: call.id, name: call.name, input };
        }
        toolAccum.clear();
        yield { type: 'done' };
      }
    }

    // Fallback done if stream ended without finish_reason
    if (reasoningAcc) yield { type: 'reasoning-block', reasoning: reasoningAcc };
    if (toolAccum.size > 0) {
      for (const [, call] of toolAccum) {
        let input: unknown = {};
        try { input = JSON.parse(call.args || '{}'); } catch { /* malformed */ }
        yield { type: 'tool-call', id: call.id, name: call.name, input };
      }
    }
    yield { type: 'done' };
  }

  async health(): Promise<HealthStatus> {
    return { status: 'ok' };
  }
}
