import type { Message, Tool, JSONSchema } from '@matatbread/matbot-plugin-api';

// ── Internal Anthropic API types ──────────────────────────────────────────────

type CacheControl = { type: 'ephemeral' };

type AnthropicTextBlock        = { type: 'text';              text: string;           cache_control?: CacheControl };
type AnthropicThinkingBlock    = { type: 'thinking';          thinking: string; signature: string };
type AnthropicRedactedThinking = { type: 'redacted_thinking'; data: string };
type AnthropicImageBlock       = { type: 'image';             source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } };
type AnthropicToolUse          = { type: 'tool_use';          id: string; name: string; input: unknown };
type AnthropicToolResult       = { type: 'tool_result';       tool_use_id: string; content: string; is_error?: boolean };
type AnthropicContent          = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicRedactedThinking | AnthropicImageBlock | AnthropicToolUse | AnthropicToolResult;

export interface AnthropicMessage {
  role:    'user' | 'assistant';
  content: AnthropicContent[];
}

export interface AnthropicToolDef {
  name:         string;
  description:  string;
  input_schema: JSONSchema;
  cache_control?: CacheControl;
}

// ── Message conversion ────────────────────────────────────────────────────────

export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;   // handled via system= parameter
    if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'tool') continue;

    const role: 'user' | 'assistant' =
      msg.role === 'tool' ? 'user' : msg.role;

    const content: AnthropicContent[] = msg.content.flatMap((c): AnthropicContent[] => {
      switch (c.type) {
        case 'text':
          return [{ type: 'text', text: c.text }];
        case 'thinking':
        case 'redacted-thinking':
          // Anthropic thinking blocks are signed provider-native state, not
          // portable conversation content. The API accepts them only when the
          // signature verifies for the exact target request; the neutral message
          // format does not carry enough information to prove that, so elide
          // them deterministically rather than sending possibly-invalid input.
          return [];
        case 'reasoning':
          return [];  // OpenAI/DeepSeek reasoning — strip; Anthropic has no equivalent
        case 'image':
          return [{ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } }];
        case 'image-url':
          return [{ type: 'image', source: { type: 'url', url: c.url } }];
        case 'tool-call':
          return [{ type: 'tool_use', id: c.id, name: c.name, input: c.input as unknown }];
        case 'tool-result':
          // `?? null` so a no-result tool (e.g. remember_fact, which yields only a marker) becomes
          // the string "null" rather than JSON.stringify(undefined) → undefined; a tool_result must
          // carry content.
          return [{ type: 'tool_result', tool_use_id: c.id,
            content: JSON.stringify(c.result ?? null),
            ...(c.isError ? { is_error: true } : {}),
          }];
        case 'file-ref':
          return [{ type: 'text', text: `[Attached file: ${c.name}]` }];
        case 'document':
          return [{ type: 'text', text: `[Document: ${c.name ?? c.mimeType}]` }];
        case 'audio':
          return [{ type: 'text', text: `[Audio: ${c.mimeType}]` }];
        case 'refusal':
        case 'form':
        case 'form-response':
        case 'marker':         // opaque UI annotation; transparent to the model
        case 'unknown-content':
          return [];
      }
    });

    if (content.length > 0) result.push({ role, content });
  }

  // Cache the second-to-last user turn (stable across the next request)
  const userTurns = result.reduce<number[]>((acc, m, i) => {
    if (m.role === 'user') acc.push(i);
    return acc;
  }, []);

  if (userTurns.length >= 2) {
    const idx  = userTurns[userTurns.length - 2]!;
    const turn = result[idx]!;
    const last = turn.content[turn.content.length - 1];
    if (last && last.type === 'text') {
      (last as AnthropicTextBlock).cache_control = { type: 'ephemeral' };
    }
  }

  return result;
}

export function toAnthropicSystem(messages: Message[]): string | undefined {
  const parts = messages
    .filter(m => m.role === 'system')
    .flatMap(m => m.content)
    .filter(c => c.type === 'text')
    .map(c => (c as { type: 'text'; text: string }).text);

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

export function toAnthropicTools(tools: readonly Tool[]): AnthropicToolDef[] {
  const defs: AnthropicToolDef[] = tools.map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.inputSchema,
  }));

  // Cache tool definitions — they're stable across turns
  if (defs.length > 0) {
    defs[defs.length - 1]!.cache_control = { type: 'ephemeral' };
  }

  return defs;
}
