import type { Message, Tool, JSONSchema } from '@matatbread/matbot-plugin-api';

// ── Internal Anthropic API types ──────────────────────────────────────────────

export type CacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h' };

type AnthropicTextBlock        = { type: 'text';              text: string;           cache_control?: CacheControl };
type AnthropicThinkingBlock    = { type: 'thinking';          thinking: string; signature: string };
type AnthropicRedactedThinking = { type: 'redacted_thinking'; data: string };
type AnthropicImageBlock       = { type: 'image';             source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }; cache_control?: CacheControl };
// A base64 document source carries PDFs only; plain text has its own source shape and takes the
// decoded text, not base64. Anything else has no document representation and degrades to a text note.
type AnthropicDocumentBlock    = { type: 'document';          source: { type: 'base64'; media_type: 'application/pdf'; data: string } | { type: 'text'; media_type: 'text/plain'; data: string }; title?: string; cache_control?: CacheControl };
type AnthropicToolUse          = { type: 'tool_use';          id: string; name: string; input: unknown; cache_control?: CacheControl };
type AnthropicToolResult       = { type: 'tool_result';       tool_use_id: string; content: string; is_error?: boolean; cache_control?: CacheControl };
type AnthropicContent          = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicRedactedThinking | AnthropicImageBlock | AnthropicDocumentBlock | AnthropicToolUse | AnthropicToolResult;

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

// cache_control is valid on any block type we emit as a message's last block (text / image /
// tool_use / tool_result). thinking/redacted blocks are stripped before this point and the API
// rejects cache_control on them, so the last block is always cacheable.
function cacheLastBlock(msg: AnthropicMessage, cc: CacheControl): void {
  const last = msg.content[msg.content.length - 1];
  if (last) (last as { cache_control?: CacheControl }).cache_control = cc;
}

// Message content is base64 whatever the mime type; a text document must be sent decoded. atob yields
// one byte per char, so re-widen through TextDecoder rather than trusting it for anything non-ASCII.
function decodeBase64Text(data: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(data), ch => ch.charCodeAt(0)));
}

export function toAnthropicMessages(messages: Message[], cc: CacheControl): AnthropicMessage[] {
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
        case 'reasoning': {
          // OpenAI/DeepSeek reasoning — Anthropic has no native equivalent. Strip for plain-chat turns
          // (DeepSeek ignores prior reasoning when there are no tool calls). On tool-call turns DeepSeek
          // requires it to be passed back or the request 400s, so degrade to a text marker.
          const hasToolCalls = msg.content.some(mc => mc.type === 'tool-call');
          return hasToolCalls
            ? [{ type: 'text', text: `[Prior reasoning: ${c.reasoning}]` }]
            : [];
        }
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
          if (c.mimeType === 'application/pdf')
            return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: c.data },
              ...(c.name !== undefined ? { title: c.name } : {}) }];
          if (c.mimeType.startsWith('text/'))
            return [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: decodeBase64Text(c.data) },
              ...(c.name !== undefined ? { title: c.name } : {}) }];
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

    // Adjacent same-role messages are not valid wire: fold into the previous one. Arises whenever a
    // neutral message renders alongside another of the same role — tool results (role 'user' here)
    // followed by tool-supplied media, or an assistant turn stripped back to text by an elision.
    const prev = result[result.length - 1];
    if (content.length === 0)     continue;
    if (prev && prev.role === role) prev.content.push(...content);
    else                            result.push({ role, content });
  }

  // Roll a cache breakpoint across the two most-recent messages. Each turn advances the cache write
  // frontier to the newest content (which becomes stable history next turn), while the earlier of the
  // two stays within the 20-block lookback so the next request finds a prior entry to read from.
  // Placed on the last block whatever its type: tool-result turns (role 'user', last block a
  // tool_result) are cacheable, and the old text-only guard skipped them entirely — the dominant
  // cause of uncached agentic tool loops.
  const lastMsg = result[result.length - 1];
  if (lastMsg) cacheLastBlock(lastMsg, cc);
  const prevMsg = result[result.length - 2];
  if (prevMsg) cacheLastBlock(prevMsg, cc);

  return result;
}

// Returned as a block array (not a bare string) so the system prompt carries its own cache breakpoint.
// It renders after `tools`, so this breakpoint caches tools + system together as one stable anchor —
// robust even when a long tool turn pushes the message breakpoints past the 20-block lookback.
export function toAnthropicSystem(messages: Message[], cc: CacheControl): AnthropicTextBlock[] | undefined {
  const parts = messages
    .filter(m => m.role === 'system')
    .flatMap(m => m.content)
    .filter(c => c.type === 'text')
    .map(c => (c as { type: 'text'; text: string }).text);

  return parts.length > 0 ? [{ type: 'text', text: parts.join('\n\n'), cache_control: cc }] : undefined;
}

export function toAnthropicTools(tools: readonly Tool[], cc: CacheControl): AnthropicToolDef[] {
  const defs: AnthropicToolDef[] = tools.map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.inputSchema,
  }));

  // Cache tool definitions — they're stable across turns. Kept as a separate anchor from the system
  // breakpoint so tools still read from cache if the system prompt ever varies between turns.
  if (defs.length > 0) {
    defs[defs.length - 1]!.cache_control = cc;
  }

  return defs;
}
