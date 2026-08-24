import type { Message, MessageContent, Tool, JSONSchema } from '@matatbread/matbot-plugin-api';

// Gemini 3 thought signatures ride on a tool-call's `ProviderMeta`, namespaced under `google`. Homed in
// THIS package (not the native @matatbread/matbot-provider-google adapter) because both surfaces round-
// trip them — this OpenAI-compat gemini mode and the native adapter, which depends on this package and so
// sees the augmentation transitively. Core carries `meta` opaquely; only these two adapters read `google`.
declare module '@matatbread/matbot-plugin-api' {
  interface ProviderMeta { google?: { thoughtSignature?: string } }
}

// ── Internal OpenAI API types ─────────────────────────────────────────────────

type OAIRole    = 'system' | 'user' | 'assistant' | 'tool';

export interface OAIMessage {
  role:         OAIRole;
  content?:     string | OAIContentPart[] | null;
  /** Prior reasoning replayed on the SAME field the adapter read it from (`delta.reasoning_content`).
   *  Set only on an assistant turn that also carries tool calls — see the `reasoning` case below. */
  reasoning_content?: string;
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
  // Gemini-only WIRE shape (snake_case, per Google's OpenAI-compat spec): the round-tripped thought
  // signature. Written by `toOAIMessages` in gemini mode, translated from the tool-call's neutral
  // `meta.google.thoughtSignature`; never sent to other OpenAI-compatible providers.
  extra_content?: { google: { thought_signature: string } };
}

export interface OAIToolDef {
  type:     'function';
  function: { name: string; description: string; parameters: JSONSchema };
  cache_control?: CacheControl;
}

// A foreign (non-Gemini) tool call can't be replayed to Gemini as a native functionCall — it lacks the
// mandatory thought signature. Rather than eliding it (which drops the facts the tool returned and invites
// confabulation), the gemini renderers degrade the call+result to this plain-text context note, emitted at
// the result's position. Lossy — prose, not a real tool exchange the model can chain from — but the
// substance survives. Args/result are clipped so a chatty tool doesn't balloon every subsequent turn (the
// note rides in context on every future turn). Shared so the native and OpenAI-compat renderers agree.
export function foreignToolNote(name: string, args: unknown, result: unknown): string {
  const clip = (v: unknown, max: number): string => {
    const s = JSON.stringify(v ?? null) ?? 'null';
    return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
  };
  return `[Earlier tool call — ${name}(${clip(args, 400)}) → ${clip(result, 2000)}]`;
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

export function toOAIMessages(messages: Message[], cache = false, geminiMode = false): OAIMessage[] {
  const result: OAIMessage[] = [];

  // Gemini rejects any historical functionCall lacking a thought_signature. A call produced by another
  // provider — or before gemini mode was on — has none, so in gemini mode we can't replay it as a native
  // call: the call itself is elided, and its paired tool-result is degraded to a text context note (see
  // `foreignToolNote`) at the result's position rather than dropped, so the facts survive. (A call kept
  // here always has a signature, so emission below is unconditional for the survivors.)
  const dropIds = new Set<string>();
  const foreignCall = new Map<string, { name: string; args: unknown }>();
  if (geminiMode) {
    for (const m of messages)
      for (const c of m.content)
        if (c.type === 'tool-call' && c.meta?.google?.thoughtSignature === undefined) {
          dropIds.add(c.id);
          foreignCall.set(c.id, { name: c.name, args: c.input });
        }
  }

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
          if (dropIds.has(c.id)) {
            // its tool-call was elided — degrade the pair to a text context note instead of dropping it
            const fc = foreignCall.get(c.id);
            if (fc) result.push({ role: 'user', content: foreignToolNote(fc.name, fc.args, c.result) });
            continue;
          }
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

    const toolCalls = msg.content.filter(c => c.type === 'tool-call' && !dropIds.has(c.id));
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
        case 'tool-result':    // only in role === 'tool' messages, handled above
        case 'refusal':
        case 'form':
        case 'form-response':
        case 'marker':         // opaque UI annotation; transparent to the model
        case 'unknown-content':
          return [];
        case 'reasoning':
          // Never as text — replayed on `reasoning_content` below, the field it was READ from. See there.
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

    // Prior reasoning goes back on `reasoning_content` — the same field `adapter.ts` READ it from.
    // It used to be degraded into a `[Prior reasoning: …]` TEXT part instead, which was wrong twice
    // over: it did not satisfy what the endpoint asks for (a reasoning field, not prose), and the
    // model could not tell matbot's framing from its own words, so it learned the pattern and began
    // emitting `[Prior reasoning: …` as ordinary output — reasoning leaking into the visible answer,
    // in a text block that never closed its bracket. A field cannot be imitated; a sentence can.
    //
    // Still only on tool-call turns: a plain-chat replay is tokens for nothing (the endpoint ignores
    // prior reasoning there), and that condition is the one part of the original behaviour that was
    // load-bearing. Unknown message fields are ignored by strict OpenAI-family backends — verified
    // accepted by both DeepSeek and gpt-5.x — so this is safe for everything openai-compat fronts.
    if (toolCalls.length > 0) {
      const reasoning = msg.content
        .filter((c): c is Extract<MessageContent, { type: 'reasoning' }> => c.type === 'reasoning')
        .map(c => c.reasoning).join('\n');
      if (reasoning) oaiMsg.reasoning_content = reasoning;

      oaiMsg.tool_calls = toolCalls.map(c => {
        if (c.type !== 'tool-call') return null!;
        const call: OAIToolCall = {
          id:       c.id,
          type:     'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        };
        // Survivors in gemini mode always carry a signature (the rest were elided into dropIds); echo
        // it back so Gemini accepts the replayed call. Never emitted for other providers.
        const sig = c.meta?.google?.thoughtSignature;
        if (geminiMode && sig !== undefined) {
          call.extra_content = { google: { thought_signature: sig } };
        }
        return call;
      }).filter(Boolean);
    }

    // Provider-specific reasoning/thinking blocks are intentionally stripped above. If that leaves a
    // message with neither content nor tool calls, drop it rather than send an empty one.
    if (oaiMsg.content === undefined && (oaiMsg.tool_calls?.length ?? 0) === 0) continue;

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
