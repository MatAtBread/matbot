import type { Message, Tool } from '@matatbread/matbot-plugin-api';
import { foreignToolNote } from '@matatbread/matbot-provider-openai-compat';

// ── Native Gemini (generateContent) wire types ────────────────────────────────
// See https://ai.google.dev/api/generate-content. The native format differs from OpenAI's in three
// ways that matter here: (1) only `user`/`model` roles exist — tool results ride in a `user` turn as
// `functionResponse` parts; (2) the system prompt is a top-level `systemInstruction`, not a message;
// (3) Gemini 3 thought signatures are a sibling field on the part (`thoughtSignature`), and every
// historical `functionCall` MUST carry one or the request 400s — the same constraint the OpenAI-compat
// path hits over `extra_content.google.thought_signature`.

export interface GeminiPart {
  text?:             string;
  thought?:          boolean;
  thoughtSignature?: string;
  functionCall?:     { name: string; args: unknown; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  inlineData?:       { mimeType: string; data: string };
}

export interface GeminiContent {
  role:  'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name:        string;
  description: string;
  parameters:  unknown;   // Gemini's OpenAPI-subset Schema (see sanitizeSchema), not raw JSON Schema
}

// Gemini's native functionDeclarations accept only a strict OpenAPI-3.0 Schema subset — unknown JSON
// Schema keywords (`additionalProperties`, `$schema`, `$ref`, `patternProperties`, …) are hard-rejected
// with a 400 (unlike the OpenAI-compat backend, which silently tolerates them). So we recursively keep
// only the fields Gemini's Schema proto defines, and normalise the few JSON-Schema-isms that map:
// `type: [...,"null"]` → `nullable`, `const` → single-value `enum`, `oneOf`/`allOf` → `anyOf`. Dropping
// an unknown keyword (e.g. `$ref`) degrades that node to an untyped `{}` rather than failing the call.
const SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'default', 'items', 'minItems', 'maxItems',
  'enum', 'properties', 'required', 'minProperties', 'maxProperties', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'example', 'propertyOrdering',
]);

function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const rawType = src['type'];
  if (Array.isArray(rawType)) {
    const nonNull = rawType.filter(t => t !== 'null');
    if (rawType.includes('null')) out['nullable'] = true;
    if (nonNull.length === 1) out['type'] = nonNull[0];
    else if (nonNull.length > 1) out['anyOf'] = nonNull.map(t => ({ type: t }));
  } else if (rawType !== undefined) {
    out['type'] = rawType;
  }

  if ('const' in src && !('enum' in src)) out['enum'] = [src['const']];

  const union = src['anyOf'] ?? src['oneOf'] ?? src['allOf'];
  if (Array.isArray(union)) out['anyOf'] = union.map(sanitizeSchema);

  for (const [k, v] of Object.entries(src)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === 'type') continue;   // owned by the block above (array → scalar/nullable/anyOf) — never re-copy the raw value
    if (k === 'properties' && v !== null && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = sanitizeSchema(pv);
      out['properties'] = props;
    } else if (k === 'items') {
      out['items'] = sanitizeSchema(v);
    } else {
      out[k] = v;   // scalars, `enum`/`required` arrays of literals — passed through verbatim
    }
  }
  // Gemini requires `items` on every array-typed schema (a loose `{ type: 'array' }` — which the
  // OpenAI-compat backend tolerates — is rejected). Inject a permissive element schema when absent.
  if (out['type'] === 'array' && out['items'] === undefined) out['items'] = {};
  return out;
}

// Gemini's functionResponse.response is a JSON object (Struct). A tool that returns a bare
// scalar/array/null is wrapped so the wire stays valid; an object is passed through as the tool
// framed it (isError is not separately surfaced — Gemini has no error channel here).
function toResponseObject(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { result: result ?? null };
}

export function toGeminiSystem(messages: Message[]): { parts: GeminiPart[] } | undefined {
  const parts = messages
    .filter(m => m.role === 'system')
    .flatMap(m => m.content)
    .filter(c => c.type === 'text')
    .map(c => (c as { type: 'text'; text: string }).text);
  return parts.length > 0 ? { parts: [{ text: parts.join('\n\n') }] } : undefined;
}

function dataUrlToInline(url: string): GeminiPart | undefined {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m) return undefined;
  const [, mimeType, isB64, payload] = m;
  if (!isB64) return undefined;   // only base64 data URLs map cleanly to inlineData
  return { inlineData: { mimeType: mimeType ?? 'application/octet-stream', data: payload ?? '' } };
}

export function toGeminiContents(messages: Message[], currentProvider?: string): GeminiContent[] {
  // A thought signature is only valid for the exact provider (and context) that minted it, so we trust
  // one *only* when the message that produced it came from the provider we're now sending to. Presence
  // alone is not enough: a `functionCall` signature is Gemini-only, but a *thinking*-block signature can
  // just as well be Anthropic's — replaying that in Gemini's `thoughtSignature` slot yields a hard
  // "Corrupted thought signature" 400. So: a functionCall from another provider (no signature, or a
  // signature we don't trust) is elided along with its paired functionResponse — a degraded but valid
  // render of foreign history — and a foreign thinking block is dropped entirely (below).
  const dropIds = new Set<string>();
  const nameById = new Map<string, string>();
  const argsById = new Map<string, unknown>();
  for (const m of messages) {
    const ownSig = m.providerName === currentProvider;
    for (const c of m.content)
      if (c.type === 'tool-call') {
        nameById.set(c.id, c.name);
        argsById.set(c.id, c.input);
        if (c.meta?.google?.thoughtSignature === undefined || !ownSig) dropIds.add(c.id);
      }
  }

  const built: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;   // → systemInstruction

    if (msg.role === 'tool') {
      const parts: GeminiPart[] = [];
      for (const c of msg.content) {
        if (c.type !== 'tool-result') continue;
        const name = nameById.get(c.id);
        if (dropIds.has(c.id)) {
          // its functionCall was elided (foreign/unsigned) — degrade the pair to a text context note at
          // the result's position rather than dropping it, so the facts the tool returned survive.
          if (name !== undefined) parts.push({ text: foreignToolNote(name, argsById.get(c.id), c.result) });
          continue;
        }
        if (name === undefined) continue;                // no matching call to name it — cannot send
        parts.push({ functionResponse: { name, response: toResponseObject(c.result), id: c.id } });
      }
      if (parts.length > 0) built.push({ role: 'user', parts });
      continue;
    }

    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';

    const parts: GeminiPart[] = [];
    for (const c of msg.content) {
      switch (c.type) {
        case 'text':
          if (c.text) parts.push({ text: c.text });
          break;
        case 'thinking':
          // Round-trip a thinking block's signature only when this turn came from the current provider
          // (see the trust rule above): a foreign thinking signature (e.g. Anthropic's) is not a valid
          // Gemini thought signature and is rejected as "corrupted". Otherwise elide the block.
          if (c.signature && msg.providerName === currentProvider)
            parts.push({ text: c.thinking, thought: true, thoughtSignature: c.signature });
          break;
        case 'tool-call': {
          if (dropIds.has(c.id)) break;                  // signature-less / foreign — elided (see dropIds)
          const sig = c.meta?.google?.thoughtSignature;   // survivors always carry one; kept for clarity
          parts.push({
            functionCall: { name: c.name, args: c.input, id: c.id },
            ...(sig !== undefined ? { thoughtSignature: sig } : {}),
          });
          break;
        }
        case 'image':
          parts.push({ inlineData: { mimeType: c.mimeType, data: c.data } });
          break;
        case 'image-url': {
          const inline = dataUrlToInline(c.url);
          parts.push(inline ?? { text: `[Image: ${c.url}]` });
          break;
        }
        case 'file-ref': parts.push({ text: `[Attached file: ${c.name}]` }); break;
        // Gemini takes documents and audio the same way it takes images — inline bytes plus a mime
        // type — so there is nothing to degrade.
        case 'document': parts.push({ inlineData: { mimeType: c.mimeType, data: c.data } }); break;
        case 'audio':    parts.push({ inlineData: { mimeType: c.mimeType, data: c.data } }); break;
        case 'redacted-thinking':
        case 'reasoning':
        case 'tool-result':      // only in role === 'tool', handled above
        case 'refusal':
        case 'form':
        case 'form-response':
        case 'marker':           // opaque UI annotation; transparent to the model
        case 'unknown-content':
          break;
      }
    }
    if (parts.length > 0) built.push({ role, parts });
  }

  // Gemini wants strictly alternating user/model turns; eliding foreign tool calls can leave adjacent
  // same-role contents (e.g. a model turn reduced to text, then another model turn). Merge them.
  const merged: GeminiContent[] = [];
  for (const c of built) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else merged.push(c);
  }
  return merged;
}

export function toGeminiTools(tools: readonly Tool[]): Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> {
  const decls: GeminiFunctionDeclaration[] = tools.map(t => ({
    name:        t.name,
    description: t.description,
    parameters:  sanitizeSchema(t.inputSchema),
  }));
  return decls.length > 0 ? [{ functionDeclarations: decls }] : [];
}
