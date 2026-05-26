import type { Message, Tool, JSONSchema } from '@matbot/plugin-api';

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
      if (c.type === 'text')      return [{ type: 'text', text: c.text }];
      if (c.type === 'image')     return [{ type: 'image_url', image_url: { url: `data:${c.mimeType};base64,${c.data}` } }];
      if (c.type === 'image-url') return [{ type: 'image_url', image_url: { url: c.url, ...(c.detail !== undefined ? { detail: c.detail } : {}) } }];
      if (c.type === 'file-ref')  return [{ type: 'text', text: `[Attached file: ${c.name}]` }];
      return [];
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
