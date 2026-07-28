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

    const body = JSON.stringify({
      messages: chatMessages,
      chatOptions: {
        selectedModel: model,
        systemPrompt: '',
        topK: config.parameters?.topK ?? 8,
      },
      attachment: null,
    });

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

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`ChatJimmy ${res.status}: ${text}`);
    }

    const text = await res.text();

    // Strip stats block
    const statsStart = text.lastIndexOf('<|stats|>');
    const statsEnd = text.lastIndexOf('<|/stats|>');
    const responseText = statsStart >= 0 ? text.slice(0, statsStart).trimEnd() : text.trim();
    let stats: Partial<ChatJimmyStats> = {};

    if (statsStart >= 0 && statsEnd > statsStart) {
      try { stats = JSON.parse(text.slice(statsStart + 9, statsEnd)) as ChatJimmyStats; } catch {}
    }

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
