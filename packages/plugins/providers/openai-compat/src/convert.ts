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

type OAIContentPart =
  | { type: 'text';      text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OAIToolCall {
  id:       string;
  type:     'function';
  function: { name: string; arguments: string };
}

export interface OAIToolDef {
  type:     'function';
  function: { name: string; description: string; parameters: JSONSchema };
}

// ── Message conversion ────────────────────────────────────────────────────────

export function toOAIMessages(messages: Message[]): OAIMessage[] {
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
            // `?? null` so a no-result tool (e.g. remember_fact, which yields only a marker) becomes
            // the string "null" rather than `JSON.stringify(undefined)` → undefined (a non-string the
            // API rejects). Every tool message must carry a string content.
            content:      JSON.stringify(c.result ?? null),
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

    let content: string | OAIContentPart[] | undefined;
    const first = contentParts[0];
    if (contentParts.length === 1 && first !== undefined && first.type === 'text') {
      content = first.text;  // plain string for text-only messages
    } else if (contentParts.length > 0) {
      content = contentParts;
    }

    // Set `content` only when there is some — never an explicit `null`. The spec makes `content`
    // optional once `tool_calls` is present, and stricter validators (e.g. gpt-5.x) reject
    // `"content": null` with "expected a string, got null". So an assistant tool-call turn with no
    // text is sent as `{ role, tool_calls }`, content omitted.
    const oaiMsg: OAIMessage = { role: msg.role };
    if (content !== undefined) oaiMsg.content = content;

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

    // Provider-specific reasoning/thinking blocks are intentionally stripped above. If that leaves a
    // message with neither content nor tool calls, drop it rather than send an empty one.
    if (oaiMsg.content === undefined && (oaiMsg.tool_calls?.length ?? 0) === 0) continue;

    result.push(oaiMsg);
  }

  return result;
}

export function toOAITools(tools: readonly Tool[]): OAIToolDef[] {
  return tools.map(t => ({
    type:     'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}
