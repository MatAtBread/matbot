import type {
  ProviderAdapter, ProviderConfig, Message, MessageContent,
  Tool, CompletionEvent, HealthStatus,
} from '@matatbread/matbot-plugin-api';

const DEFAULT_ENDPOINT = 'https://chatjimmy.ai/api/chat';
const DEFAULT_MODEL    = 'llama3.1-8B';

interface ChatJimmyStats {
  decode_rate:    number;
  decode_tokens:  number;
  prefill_rate:   number;
  prefill_tokens: number;
  total_tokens:   number;
  total_time:     number;
  ttft:           number;
  roundtrip_time: number;
  done_reason:    string;
}

function extractText(content: Message['content']): string {
  return content
    .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

export class ChatJimmyAdapter implements ProviderAdapter {
  readonly name: string;

  constructor(name = 'chatjimmy') {
    this.name = name;
  }

  complete(
    messages: Message[],
    config:   ProviderConfig,
    _tools:   readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    return this.infer(messages, config, signal);
  }

  private async *infer(
    messages: Message[],
    config:   ProviderConfig,
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    const model    = config.model    ?? DEFAULT_MODEL;

    const t0 = performance.now();

    // Build the flat chat message list
    const chatMessages: Array<{ role: string; content: string }> = [];
    for (const m of messages) {
      if (m.role === 'user') {
        const text = extractText(m.content);
        if (text) chatMessages.push({ role: 'user', content: text });
      } else if (m.role === 'assistant') {
        const text = extractText(m.content);
        if (text) chatMessages.push({ role: 'assistant', content: text });
      }
    }

    if (chatMessages.length === 0) {
      throw new Error('ChatJimmy requires at least one user message');
    }

    const t1 = performance.now();
    console.log(`[chatjimmy] Message build: ${(t1 - t0).toFixed(1)}ms — ${chatMessages.length} messages from ${messages.length} input`);

    const body = JSON.stringify({
      messages: chatMessages,
      chatOptions: {
        selectedModel: model,
        systemPrompt: '',
        topK: config.parameters?.topK ?? 8,
      },
      attachment: null,
    });

    const t2 = performance.now();
    console.log(`[chatjimmy] Body serialization: ${(t2 - t1).toFixed(1)}ms`);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'origin':       'https://chatjimmy.ai',
        'referer':      'https://chatjimmy.ai/',
      },
      body,
      signal,
    });

    const t3 = performance.now();
    console.log(`[chatjimmy] HTTP response received: ${(t3 - t2).toFixed(1)}ms (status ${res.status})`);

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`ChatJimmy ${res.status}: ${text}`);
    }

    const text = await res.text();

    const t4 = performance.now();
    console.log(`[chatjimmy] Body read: ${(t4 - t3).toFixed(1)}ms (${text.length} bytes)`);

    // Strip stats block
    const statsStart = text.lastIndexOf('<|stats|>');
    const statsEnd = text.lastIndexOf('<|/stats|>');
    const responseText = statsStart >= 0 ? text.slice(0, statsStart).trimEnd() : text.trim();
    let stats: Partial<ChatJimmyStats> = {};

    if (statsStart >= 0 && statsEnd > statsStart) {
      try { stats = JSON.parse(text.slice(statsStart + 9, statsEnd)) as ChatJimmyStats; } catch {}
    }

    const t5 = performance.now();
    console.log(`[chatjimmy] Stats parse: ${(t5 - t4).toFixed(1)}ms`);
    console.log(`[chatjimmy] HC1 chip says: ${stats.prefill_tokens ?? '?'} prefill tokens @ ${stats.prefill_rate?.toFixed(0) ?? '?'} tok/s, ${stats.decode_tokens ?? '?'} decode tokens @ ${stats.decode_rate?.toFixed(0) ?? '?'} tok/s, TTFT=${(stats.ttft ?? 0) * 1000}ms, chip time=${((stats.total_time ?? 0) * 1000).toFixed(2)}ms, net roundtrip=${stats.roundtrip_time ?? '?'}ms`);
    console.log(`[chatjimmy] TOTAL adapter time: ${(t5 - t0).toFixed(1)}ms`);

    if (responseText) {
      yield { type: 'text-delta', delta: responseText };
    }

    if (stats.total_tokens != null) {
      yield {
        type: 'usage',
        inputTokens:  stats.prefill_tokens ?? 0,
        outputTokens: stats.decode_tokens  ?? 0,
      };
    }

    yield { type: 'done' };
  }

  async health(): Promise<HealthStatus> {
    try {
      const res = await fetch('https://chatjimmy.ai/api/models', {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return res.ok
        ? { status: 'ok' }
        : { status: 'degraded', reason: `models endpoint returned ${res.status}` };
    } catch (e) {
      return { status: 'down', reason: e instanceof Error ? e.message : String(e) };
    }
  }
}
