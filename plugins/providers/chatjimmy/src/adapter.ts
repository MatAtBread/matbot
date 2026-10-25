import type {
  ProviderAdapter, ProviderConfig, Message,
  Tool, CompletionEvent, HealthStatus,
} from '@matatbread/matbot-plugin-api';
import { parseReply, type Piece } from './format.js';
import { DEFAULT_CONTEXT, REPLY_RESERVE, fitToWindow, size } from './window.js';

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

export class ChatJimmyAdapter implements ProviderAdapter {
  readonly name: string;

  constructor(name = 'chatjimmy') {
    this.name = name;
  }

  complete(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    return this.infer(messages, config, tools, signal);
  }

  private async *infer(
    messages: Message[],
    config:   ProviderConfig,
    tools:    readonly Tool[],
    signal:   AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    const model    = config.model    ?? DEFAULT_MODEL;
    const params   = config.parameters ?? {};
    // `tools: false` turns it off: a profile kept for latency tests may not want an 8B model calling tools
    // from a prompt, which fumbles often enough (see format.ts) to skew what it measures.
    const offered  = params['tools'] === false ? [] : tools;

    // System text has nowhere to go in the message array: the endpoint takes it out of band, in
    // chatOptions.systemPrompt (verified honoured — a systemPrompt demanding a specific first word
    // is obeyed). It used to be dropped entirely, which is the worst of both: a caller that sent
    // one got a silently different model back, answering the user's words as a plain assistant.
    // That matters most for the inner voice, whose whole framing IS a system prompt — stripped, it
    // stops critiquing and starts paraphrasing, with no error anywhere.
    const contextWindow = typeof params['contextWindow'] === 'number' ? params['contextWindow'] : DEFAULT_CONTEXT;
    const reserve       = typeof params.maxTokens === 'number' ? params.maxTokens : REPLY_RESERVE;
    const { systemPrompt, messages: chatMessages, cuts } = fitToWindow(messages, offered, Math.max(0, contextWindow - reserve));
    if (cuts.length > 0) console.warn(`[chatjimmy] to fit the ${contextWindow}-token context window: ${cuts.join('; ')}. The session is unchanged.`);

    if (chatMessages.length === 0) {
      throw new Error('ChatJimmy requires at least one user message');
    }

    const body = JSON.stringify({
      messages: chatMessages,
      chatOptions: {
        selectedModel: model,
        systemPrompt,
        // Greedy when tools are offered: measured on matbot's first round, top-k 4 talked about tools,
        // invented one, or searched on a greeting about a third of the time, where top-k 1 called
        // `tool_search` with a sensible query every time. A profile's own `topK` still wins.
        topK: params.topK ?? (offered.length > 0 ? 1 : 8),
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
    // `debug` logs every exchange whole, for tuning against real turns: what the model saw and wrote.
    if (params['debug'] === true) console.debug('[chatjimmy] exchange', { systemPrompt, messages: chatMessages, reply: text });

    // An empty body — no reply, no stats — is how the endpoint refuses a request too long for its window.
    if (!text.trim()) {
      throw new Error(`ChatJimmy returned an empty response, which it does when a request is too long for its context window `
        + `(this one was ${size({ systemPrompt, messages: chatMessages })} characters). If that keeps happening, lower `
        + '`parameters.contextWindow` on this profile.');
    }

    // Strip stats block
    const statsStart = text.lastIndexOf('<|stats|>');
    const statsEnd = text.lastIndexOf('<|/stats|>');
    const responseText = statsStart >= 0 ? text.slice(0, statsStart).trimEnd() : text.trim();
    let stats: Partial<ChatJimmyStats> = {};

    if (statsStart >= 0 && statsEnd > statsStart) {
      try { stats = JSON.parse(text.slice(statsStart + 9, statsEnd)) as ChatJimmyStats; } catch {}
    }

    if (offered.length === 0) {
      if (responseText) yield { type: 'text-delta', delta: responseText };
    } else {
      const { pieces, dropped } = parseReply(responseText, {
        maxCalls:  typeof params['maxCalls'] === 'number' ? params['maxCalls'] : 1,
        bareCalls: params['lenientCalls'] !== false,
      });
      if (dropped) console.warn('[chatjimmy] reply continued past its tool call — dropped', { dropped });
      yield* events(pieces, stats.done_reason);
    }

    if (stats.total_tokens != null) {
      yield {
        type: 'usage',
        inputTokens:  stats.prefill_tokens ?? 0,
        outputTokens: stats.decode_tokens  ?? 0,
      };
    }

    if (stats.done_reason === 'length') yield { type: 'truncated', reason: 'max-tokens', raw: stats.done_reason };
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

function* events(pieces: Piece[], doneReason: string | undefined): Generator<CompletionEvent> {
  for (const p of pieces) {
    switch (p.kind) {
      case 'text': yield { type: 'text-delta', delta: p.text }; break;
      case 'call': yield { type: 'tool-call', id: `call_${crypto.randomUUID()}`, name: p.name, input: p.arguments }; break;
      case 'cut-call':
        yield { type: 'tool-call', id: `call_${crypto.randomUUID()}`, name: p.name, input: {},
          truncated: { bytes: p.bytes, ...(doneReason ? { stopReason: doneReason } : {}) } };
        break;
      case 'unparsed-call':
        // Not run (see Piece). What the model wrote is shown instead, and it meets it again in history.
        console.warn('[chatjimmy] unreadable tool call — not run', { name: p.name, body: p.body });
        yield { type: 'text-delta', delta: `<tool_call>\n${p.body}\n</tool_call>` };
        break;
    }
  }
}
