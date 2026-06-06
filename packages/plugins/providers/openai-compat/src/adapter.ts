import type { ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus } from '@matatbread/matbot-plugin-api';
import { parseSSE } from '@matatbread/matbot-providers-base';
import { toOAIMessages, toOAITools } from './convert.js';

const DEFAULT_ENDPOINT   = 'https://api.openai.com/v1/chat/completions';
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
    const apiKey   = config.credentials?.['apiKey'] ?? '';

    const body: Record<string, unknown> = {
      model:      config.model,
      // Classic OpenAI `max_tokens`, not the newer `max_completion_tokens`: the compat ecosystem
      // (DeepSeek, vLLM, llama.cpp, ollama, classic gpt-4o) honors `max_tokens`. DeepSeek in
      // particular *silently ignores* `max_completion_tokens` — verified against api.deepseek.com —
      // so sending it leaves the cap unenforced. OpenAI's o-series is the lone exception (it wants
      // `max_completion_tokens` and rejects `max_tokens`); that would need a per-provider override.
      max_tokens: config.parameters?.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages:             toOAIMessages(messages),
      stream:               true,
      stream_options:       { include_usage: true },
    };

    const toolDefs = toOAITools(tools);
    if (toolDefs.length > 0) body['tools'] = toolDefs;

    if (config.parameters?.temperature !== undefined) {
      body['temperature'] = config.parameters.temperature;
    }

    const res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'content-type':  'application/json',
        'authorization': `Bearer ${apiKey}`,
        ...(config.credentials?.['organization']
          ? { 'openai-organization': config.credentials?.['organization'] }
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

      // 'length' is OpenAI's truncation reason (the analogue of Anthropic's max_tokens) — treat
      // it as terminal too, so a tool call cut off mid-arguments is flushed and surfaced here
      // rather than silently dropped to the fallback below.
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
        if (reasoningAcc) {
          yield { type: 'reasoning-block', reasoning: reasoningAcc };
          reasoningAcc = '';
        }
        let truncatedTool: { name: string; bytes: number } | undefined;
        for (const [, call] of toolAccum) {
          try {
            yield { type: 'tool-call', id: call.id, name: call.name, input: JSON.parse(call.args || '{}') };
          } catch {
            truncatedTool ??= { name: call.name, bytes: call.args.length };
          }
        }
        toolAccum.clear();
        if (truncatedTool) {
          throw new Error(
            `Tool "${truncatedTool.name}" arguments could not be parsed — ${truncatedTool.bytes} bytes received, ` +
            `finish_reason "${choice.finish_reason}". ` +
            (choice.finish_reason === 'length'
              ? 'The response hit the token limit mid tool-call; increase the provider\'s maxTokens.'
              : 'The provider returned malformed tool arguments.'),
          );
        }
        yield { type: 'done' };
      }
    }

    // Fallback if the stream ended without a finish_reason (e.g. a dropped connection).
    if (reasoningAcc) yield { type: 'reasoning-block', reasoning: reasoningAcc };
    if (toolAccum.size > 0) {
      let truncatedTool: { name: string; bytes: number } | undefined;
      for (const [, call] of toolAccum) {
        try {
          yield { type: 'tool-call', id: call.id, name: call.name, input: JSON.parse(call.args || '{}') };
        } catch {
          truncatedTool ??= { name: call.name, bytes: call.args.length };
        }
      }
      if (truncatedTool) {
        throw new Error(
          `Tool "${truncatedTool.name}" arguments could not be parsed — ${truncatedTool.bytes} bytes received ` +
          `before the stream ended. The provider returned malformed or truncated tool arguments.`,
        );
      }
    }
    yield { type: 'done' };
  }

  async health(): Promise<HealthStatus> {
    return { status: 'ok' };
  }
}
