import type { ProviderAdapter, ProviderConfig, Message, Tool, CompletionEvent, HealthStatus } from '@matatbread/matbot-plugin-api';
import { parseSSE } from '@matatbread/matbot-core/providers-base';
import { toAnthropicMessages, toAnthropicSystem, toAnthropicTools, type CacheControl } from './convert.js';

const DEFAULT_ENDPOINT   = 'https://api.anthropic.com';
const ANTHROPIC_VERSION  = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

// Minimal shapes for Anthropic SSE events — enough to drive CompletionEvent
interface AEvent { type: string; [k: string]: unknown }

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';

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

    // Default to the 1-hour cache TTL: matbot sessions are interactive, and on-disk usage showed the
    // 5-minute default expiring across normal think-time gaps (>5min → ~100% cold miss), which both
    // tanked the cache hit rate and inflated input-token throughput against the (Azure) rate limit.
    // A provider can opt back to the 5-minute default with `parameters.cacheTtl: '5m'`.
    const oneHour = config.parameters?.cacheTtl !== '5m';
    const cache: CacheControl = oneHour ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

    const body: Record<string, unknown> = {
      model:      config.model,
      max_tokens: config.parameters?.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages:   toAnthropicMessages(messages, cache),
      stream:     true,
    };

    const system = toAnthropicSystem(messages, cache);
    if (system) body['system'] = system;

    const toolDefs = toAnthropicTools(tools, cache);
    if (toolDefs.length > 0) body['tools'] = toolDefs;

    if (config.parameters?.temperature !== undefined) {
      body['temperature'] = config.parameters.temperature;
    }

    // Forward thinking mode & output config into the body (used by DeepSeek's Anthropic-compat
    // endpoint; harmless for Claude, which already accepts `thinking` per the Messages API spec).
    if (config.parameters?.thinking) {
      body.thinking = config.parameters.thinking;
    }
    if (config.parameters?.output_config) {
      body.output_config = config.parameters.output_config;
    }

    const headers: Record<string, string> = {
      'content-type':     'application/json',
      'x-api-key':        apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };

    // Enable extended thinking + prompt caching betas if requested
    const betas: string[] = ['prompt-caching-2024-07-31'];
    if (oneHour) betas.push('extended-cache-ttl-2025-04-11');   // required for the 1h cache TTL
    if (config.parameters?.thinking) betas.push('interleaved-thinking-2025-05-14');
    headers['anthropic-beta'] = betas.join(',');

    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers,
      body:   JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Anthropic ${res.status}: ${text}`);
    }

    // Accumulate content block state per index
    const toolInputs      = new Map<number, { id: string; name: string; json: string }>();
    const thinkingBlocks  = new Map<number, { thinking: string; signature: string }>();
    const redactedBlocks  = new Map<number, { data: string }>();
    const unknownBlocks   = new Map<number, { blockType: string; raw: unknown }>();
    let inputTokens = 0;
    let stopReason: string | undefined;
    // A tool_use block whose argument JSON failed to parse — almost always because the response
    // was truncated mid-stream (e.g. max_tokens). Surfaced as a hard error at message_stop rather
    // than silently delivering `{}` to the tool, which crashes downstream with no diagnostic.
    let truncatedTool: { name: string; bytes: number } | undefined;

    for await (const line of parseSSE(res.body)) {
      let ev: AEvent;
      try { ev = JSON.parse(line) as AEvent; } catch { continue; }

      switch (ev['type']) {
        case 'message_start': {
          const usage = (ev['message'] as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined)?.usage;
          if (usage?.input_tokens) {
            inputTokens = usage.input_tokens;
            yield {
              type: 'usage', inputTokens, outputTokens: 0,
              ...(usage.cache_read_input_tokens     ? { cacheReadTokens:     usage.cache_read_input_tokens     } : {}),
              ...(usage.cache_creation_input_tokens ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}),
            };
          }
          break;
        }

        case 'content_block_start': {
          const idx   = ev['index'] as number;
          const block = ev['content_block'] as { type: string; id?: string; name?: string; data?: string };
          if (block.type === 'tool_use') {
            toolInputs.set(idx, { id: block.id ?? '', name: block.name ?? '', json: '' });
          } else if (block.type === 'thinking') {
            thinkingBlocks.set(idx, { thinking: '', signature: '' });
          } else if (block.type === 'redacted_thinking') {
            redactedBlocks.set(idx, { data: block.data ?? '' });
          } else if (block.type !== 'text') {
            unknownBlocks.set(idx, { blockType: block.type, raw: ev['content_block'] });
          }
          break;
        }

        case 'content_block_delta': {
          const idx   = ev['index'] as number;
          const delta = ev['delta'] as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string };
          if (delta.type === 'text_delta' && delta.text) {
            yield { type: 'text-delta', delta: delta.text };
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            const call = toolInputs.get(idx);
            if (call) call.json += delta.partial_json;
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'thinking', delta: delta.thinking };
            const tb = thinkingBlocks.get(idx);
            if (tb) tb.thinking += delta.thinking;
          } else if (delta.type === 'signature_delta' && delta.signature) {
            const tb = thinkingBlocks.get(idx);
            if (tb) tb.signature = delta.signature;
          }
          break;
        }

        case 'content_block_stop': {
          const idx  = ev['index'] as number;
          const call = toolInputs.get(idx);
          if (call) {
            try {
              yield { type: 'tool-call', id: call.id, name: call.name, input: JSON.parse(call.json || '{}') };
            } catch {
              truncatedTool ??= { name: call.name, bytes: call.json.length };
            }
            toolInputs.delete(idx);
          }
          const tb = thinkingBlocks.get(idx);
          if (tb) {
            yield { type: 'thinking-block', thinking: tb.thinking, signature: tb.signature };
            thinkingBlocks.delete(idx);
          }
          const rb = redactedBlocks.get(idx);
          if (rb) {
            yield { type: 'redacted-thinking', data: rb.data };
            redactedBlocks.delete(idx);
          }
          const ub = unknownBlocks.get(idx);
          if (ub) {
            yield { type: 'unknown-block', blockType: ub.blockType, raw: ub.raw };
            unknownBlocks.delete(idx);
          }
          break;
        }

        case 'message_delta': {
          const stop = (ev['delta'] as { stop_reason?: string } | undefined)?.stop_reason;
          if (stop) stopReason = stop;
          const usage = (ev['usage'] as { output_tokens?: number } | undefined);
          if (usage?.output_tokens) {
            yield { type: 'usage', inputTokens: 0, outputTokens: usage.output_tokens };
          }
          break;
        }

        case 'message_stop': {
          // Flush any tool block the stream left open (truncation can end the response before
          // content_block_stop). A complete-but-unclosed block still parses; an incomplete one
          // is recorded as truncated.
          for (const [, call] of toolInputs) {
            try {
              yield { type: 'tool-call', id: call.id, name: call.name, input: JSON.parse(call.json || '{}') };
            } catch {
              truncatedTool ??= { name: call.name, bytes: call.json.length };
            }
          }
          toolInputs.clear();
          if (truncatedTool) {
            throw new Error(
              `Tool "${truncatedTool.name}" arguments could not be parsed — ${truncatedTool.bytes} bytes received` +
              `${stopReason ? `, stop_reason "${stopReason}"` : ''}. ` +
              (stopReason === 'max_tokens'
                ? 'The response hit the token limit mid tool-call; increase the provider\'s maxTokens.'
                : 'The provider returned malformed tool arguments.'),
            );
          }
          yield { type: 'done' };
          break;
        }

        case 'error': {
          const err = ev['error'] as { message?: string } | undefined;
          throw new Error(`Anthropic stream error: ${err?.message ?? JSON.stringify(ev)}`);
        }
      }
    }
  }

  async health(): Promise<HealthStatus> {
    // Lightweight check — just verify credentials key is present
    return { status: 'ok', latencyMs: 0 };
  }
}
