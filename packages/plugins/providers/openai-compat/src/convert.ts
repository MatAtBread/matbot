import type { Message, Tool, JSONSchema } from '@matatbread/matbot-plugin-api';

// ── Internal OpenAI API types ─────────────────────────────────────────────────

type OAIRole    = 'system' | 'user' | 'assistant' | 'tool';

export interface OAIMessage {
  role:         OAIRole;
  content?:     string | OAIContentPart[] | null;
  tool_calls?:  OAIToolCall[];
  tool_call_id?: string;
  name?:        string;
}

type CacheControl = { type: 'ephemeral' };

type OAIContentPart =
  | { type: 'text';      text: string; cache_control?: CacheControl }
  | { type: 'image_url'; image_url: { url: string } };

interface OAIToolCall {
  id:       string;
  type:     'function';
  function: { name: string; arguments: string };
}

export interface OAIToolDef {
  type:     'function';
  function: { name: string; description: string; parameters: JSONSchema };
  cache_control?: CacheControl;
}

// ── Message conversion ────────────────────────────────────────────────────────

// Prompt caching for OpenAI-compatible providers that honour Anthropic-style breakpoints when
// routed through OpenRouter (Anthropic / Gemini / Qwen). Opt-in via the provider's `promptCache`
// parameter — a plain OpenAI or local (ollama/vLLM) endpoint that doesn't understand `cache_control`
// must never see it, so the default stays the flat OpenAI wire shape. Mirrors the native anthropic
// adapter: cache the system prefix, the tool defs, and the second-to-last user turn (the newest
// content is left fresh — it changes next request anyway, so caching it just churns the write).
function markCacheable(msg: OAIMessage): void {
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (Array.isArray(msg.content)) {
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const part = msg.content[i]!;
      if (part.type === 'text') { part.cache_control = { type: 'ephemeral' }; return; }
    }
  }
}

function applyCacheBreakpoints(result: OAIMessage[]): void {
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]!.role === 'system') { markCacheable(result[i]!); break; }
  }
  const userTurns = result.reduce<number[]>((acc, m, i) => { if (m.role === 'user') acc.push(i); return acc; }, []);
  if (userTurns.length >= 2) markCacheable(result[userTurns[userTurns.length - 2]!]!);
}

export function toOAIMessages(messages: Message[], cache = false): OAIMessage[] {
  const result: OAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = msg.content
        .filter(c => c.type === 'text')
        .map(c => (c as { type: 'text'; text: string }).text)
        .join('\n\n');
      result.push({ role: 'system', content: text });
      continue;
    }

    if (msg.role === 'tool') {
      for (const c of msg.content) {
        if (c.type === 'tool-result') {
          result.push({
            role:         'tool',
            tool_call_id: c.id,
            content:      JSON.stringify(c.result),
          });
        }
      }
      continue;
    }

    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    const toolCalls = msg.content.filter(c => c.type === 'tool-call');
    const parts     = msg.content.filter(c => c.type !== 'tool-call');

    const contentParts: OAIContentPart[] = parts.flatMap((c): OAIContentPart[] => {
      switch (c.type) {
        case 'text':      return [{ type: 'text', text: c.text }];
        case 'image':     return [{ type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } }];
        case 'image-url': return [{ type: 'image_url', image_url: { url: c.url, ...(c.detail !== undefined ? { detail: c.detail } : {}) } }];
        case 'file-ref':  return [{ type: 'text', text: `[Attached file: ${c.name}]` }];
        case 'document':  return [{ type: 'text', text: `[Document: ${c.name ?? c.mimeType}]` }];
        case 'audio':     return [{ type: 'text', text: `[Audio: ${c.mimeType}]` }];
        case 'thinking':
        case 'redacted-thinking':
        case 'reasoning':
        case 'tool-result':    // only in role === 'tool' messages, handled above
        case 'refusal':
        case 'form':
        case 'form-response':
        case 'marker':         // opaque UI annotation; transparent to the model
        case 'unknown-content':
          return [];
      }
    });

    let content: string | OAIContentPart[] | null = null;
    const first = contentParts[0];
    if (contentParts.length === 1 && first !== undefined && first.type === 'text') {
      content = first.text;  // plain string for text-only messages
    } else if (contentParts.length > 0) {
      content = contentParts;
    }

    const oaiMsg: OAIMessage = { role: msg.role, content };

    if (toolCalls.length > 0) {
      oaiMsg.tool_calls = toolCalls.map(c => {
        if (c.type !== 'tool-call') return null!;
        return {
          id:       c.id,
          type:     'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        };
      }).filter(Boolean);
    }

    // Provider-specific reasoning/thinking blocks are intentionally stripped
    // above. If that leaves a message with no OpenAI-compatible payload, drop
    // it rather than sending an assistant/user message with null content and no
    // tool calls, which some OpenAI-compatible providers reject.
    if (content === null && (oaiMsg.tool_calls?.length ?? 0) === 0) continue;

    result.push(oaiMsg);
  }

  if (cache) applyCacheBreakpoints(result);
  return result;
}

export function toOAITools(tools: readonly Tool[], cache = false): OAIToolDef[] {
  const defs: OAIToolDef[] = tools.map(t => ({
    type:     'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  // Tool defs are stable across turns — cache them too (last breakpoint covers the whole array).
  if (cache && defs.length > 0) defs[defs.length - 1]!.cache_control = { type: 'ephemeral' };
  return defs;
}
