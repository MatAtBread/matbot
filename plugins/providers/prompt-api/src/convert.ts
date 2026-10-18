import type { Message, Tool } from '@matatbread/matbot-plugin-api';
import { textDocument } from '@matatbread/matbot-core/providers-base';
import { foreignToolNote } from '@matatbread/matbot-provider-openai-compat';
import { callIds, type LMContent, type LMMessage, type LMToolDecl, type LMToolResultContent, type ToolCtors } from './prompt-api.js';

/**
 * What the session being built can take. Each flag is a probe's answer, not a preference: a modality
 * the on-device model cannot accept fails the whole `create()`, so content it cannot take is degraded
 * to a note here rather than sent.
 */
export interface Modes {
  /** Present ⇒ tool calls round-trip natively; absent ⇒ each call+result pair becomes a text note. */
  tools: ToolCtors | undefined;
  image: boolean;
  audio: boolean;
}

export function systemText(messages: Message[]): string {
  return messages
    .filter(m => m.role === 'system')
    .flatMap(m => m.content)
    .flatMap(c => (c.type === 'text' && c.text ? [c.text] : []))
    .join('\n\n');
}

export function mediaIn(messages: Message[]): { image: boolean; audio: boolean } {
  let image = false;
  let audio = false;
  for (const m of messages)
    for (const c of m.content) {
      if (c.type === 'image' || (c.type === 'image-url' && c.url.startsWith('data:'))) image = true;
      else if (c.type === 'audio') audio = true;
    }
  return { image, audio };
}

function toBlob(data: string, mimeType: string): Blob {
  return new Blob([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))], { type: mimeType });
}

function dataUrlBlob(url: string): Blob | undefined {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? toBlob(m[2] ?? '', m[1] ?? 'application/octet-stream') : undefined;
}

// Chrome converts a tool result's `"object"` value and a call's `arguments` to its own value type and
// refuses the whole prompt if anything in them became NONE — which is what a JSON `null` converts to
// (`ContainsNoneType`, blink/modules/ai). A stored result is replayed on every later turn, so one `null`
// anywhere in it failed the session for good. A result therefore goes as JSON text: nothing is lost, the
// model reads JSON as text either way, and no converter quirk applies to a string.
function jsonText(v: unknown): string {
  try { return JSON.stringify(v) ?? 'null'; } catch { return String(v); }
}

function resultContent(result: unknown): LMToolResultContent[] {
  return [{ type: 'text', value: typeof result === 'string' ? result : jsonText(result) }];
}

function errorText(result: unknown): string {
  return typeof result === 'string' ? result : jsonText(result);
}

function withoutNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter(x => x !== null).map(withoutNulls);
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, withoutNulls(x)]));
  return v;
}

// `arguments` must stay an object, so it cannot take the text route. A historical call is context for the
// model, never re-executed, so dropping its `null` members (an absent key reads the same) is the lossy
// step that keeps it sendable. The JSON round trip also sheds what the converter cannot take at all.
function asArguments(input: unknown): Record<string, unknown> {
  let plain: unknown;
  try { plain = JSON.parse(JSON.stringify(input ?? {})); } catch { plain = {}; }
  const args = withoutNulls(plain);
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

/**
 * The non-system history, one Prompt API message per matbot message that has anything to send. System
 * text is not here: it is `initialPrompts[0]` of the base session, the one place the API keeps it
 * through a context overflow.
 *
 * A tool-call id is not provider-minted state here — the explainer says any string works so long as
 * the response repeats it — so a call made by another provider in the same session replays natively.
 */
export function toPromptMessages(messages: Message[], modes: Modes): LMMessage[] {
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const m of messages)
    for (const c of m.content)
      if (c.type === 'tool-call') calls.set(c.id, { name: c.name, input: c.input });

  const out: LMMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'marker') continue;

    if (msg.role === 'tool') {
      const content: LMContent[] = [];
      for (const c of msg.content) {
        if (c.type !== 'tool-result') continue;
        const call = calls.get(c.id);
        if (!call) continue;
        if (!modes.tools) {
          content.push({ type: 'text', value: foreignToolNote(call.name, call.input, c.result) });
        } else if (c.isError) {
          content.push({ type: 'tool-response', value: new modes.tools.error({ ...callIds(c.id), name: call.name, errorMessage: errorText(c.result) }) });
        } else {
          content.push({ type: 'tool-response', value: new modes.tools.success({ ...callIds(c.id), name: call.name, result: resultContent(c.result) }) });
        }
      }
      if (content.length > 0) out.push({ role: 'user', content });
      continue;
    }

    const content: LMContent[] = [];
    for (const c of msg.content) {
      switch (c.type) {
        case 'text':
          if (c.text) content.push({ type: 'text', value: c.text });
          break;
        case 'tool-call':
          if (modes.tools) content.push({ type: 'tool-call', value: new modes.tools.call({ ...callIds(c.id), name: c.name, arguments: asArguments(c.input) }) });
          break;
        case 'image':
          content.push(modes.image
            ? { type: 'image', value: toBlob(c.data, c.mimeType) }
            : { type: 'text',  value: '[Image omitted: this on-device model does not accept images]' });
          break;
        case 'image-url': {
          const blob = modes.image ? dataUrlBlob(c.url) : undefined;
          content.push(blob ? { type: 'image', value: blob } : { type: 'text', value: `[Image: ${c.url.startsWith('data:') ? 'inline' : c.url}]` });
          break;
        }
        case 'audio':
          content.push(modes.audio
            ? { type: 'audio', value: toBlob(c.data, c.mimeType) }
            : { type: 'text',  value: '[Audio omitted: this on-device model does not accept audio]' });
          break;
        case 'document': {
          const text = textDocument(c);
          content.push({ type: 'text', value: text ?? `[Attached file: ${c.name ?? c.mimeType} — not readable by this model]` });
          break;
        }
        case 'file-ref':
          content.push({ type: 'text', value: `[Attached file: ${c.name}]` });
          break;
        // Thoughts are stripped from the session after every turn by the API itself, so a historical
        // one has nowhere to go — and a foreign signed block would mean nothing to this model anyway.
        case 'thinking':
        case 'redacted-thinking':
        case 'reasoning':
        case 'refusal':
        case 'tool-result':
        case 'form':
        case 'form-response':
        case 'marker':
        case 'unknown-content':
          break;
      }
    }
    if (content.length > 0) out.push({ role: msg.role, content });
  }
  return out;
}

// The API requires `type: "object"` at the root of every tool's schema, which is what every matbot
// tool already declares; a schema that somehow lacks it is given one rather than failing the session.
export function toToolDecls(tools: readonly Tool[]): LMToolDecl[] {
  return tools.map(t => ({
    name:        t.name,
    description: t.description,
    inputSchema: { ...(t.inputSchema as object), type: 'object' },
  }));
}
