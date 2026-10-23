import type { Message, Tool } from '@matatbread/matbot-plugin-api';
import { textDocument } from '@matatbread/matbot-core/providers-base';
import type { ChatMessage, ResponseFormat } from './webllm.js';

// Tool calling is done here rather than through WebLLM's `tools`. That path is hard-wired to two 2024
// Hermes models, refuses any system message of the caller's (matbot's system context could not be sent),
// and forces the WHOLE reply to be a JSON array of calls, so the model could never simply answer. Instead
// the tools are described in the format Qwen (and Hermes) models are trained on — `<tools>` in the system
// prompt, `<tool_call>` in the reply — and a structural tag constrains what follows each `<tool_call>`.

const TOOLS_PREAMBLE = '# Tools\n\nYou may call one or more functions to assist with the user query.\n\n'
  + 'You are provided with function signatures within <tools></tools> XML tags:\n<tools>';
const TOOLS_POSTAMBLE = '</tools>\n\nFor each function call, return a json object with function name and arguments '
  + 'within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>';

const OPEN_CALL   = '<tool_call>';
const CLOSE_CALL  = '</tool_call>';
const OPEN_THINK  = '<think>';
const CLOSE_THINK = '</think>';

function objectSchema(schema: unknown): object {
  return { ...(schema as object), type: 'object' };
}

export function toolsPrompt(tools: readonly Tool[]): string {
  const lines = tools.map(t => JSON.stringify({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: objectSchema(t.inputSchema) },
  }));
  return `${TOOLS_PREAMBLE}\n${lines.join('\n')}\n${TOOLS_POSTAMBLE}`;
}

// Each tool is its own tag whose opening text already names it, so once the model writes `<tool_call>` it
// can only go on to name a tool that exists, and its arguments must satisfy that tool's schema. This
// enforces SHAPE — keys, types, enums, required fields — not the content of a free string.
export function toolCallFormat(tools: readonly Tool[]): ResponseFormat {
  return {
    type: 'structural_tag',
    structural_tag: {
      type:   'structural_tag',
      format: {
        type:     'triggered_tags',
        triggers: [OPEN_CALL],
        tags:     tools.map(t => ({
          type:    'tag',
          begin:   `${OPEN_CALL}\n{"name": ${JSON.stringify(t.name)}, "arguments": `,
          content: { type: 'json_schema', json_schema: objectSchema(t.inputSchema) },
          end:     `}\n${CLOSE_CALL}`,
        })),
      },
    },
  };
}

function jsonText(v: unknown): string {
  try { return JSON.stringify(v) ?? 'null'; } catch { return String(v); }
}

function renderCall(name: string, input: unknown): string {
  return `${OPEN_CALL}\n{"name": ${JSON.stringify(name)}, "arguments": ${jsonText(input ?? {})}}\n${CLOSE_CALL}`;
}

/**
 * matbot's history as WebLLM chat messages, rendered the way Qwen's own chat template renders them: an
 * assistant's calls as `<tool_call>` blocks after its text, and tool results as `<tool_response>` blocks in
 * a user turn. Deterministic on purpose — WebLLM reuses its prefill when a request extends the previous
 * conversation exactly, so every call rendering the same history the same way is what makes a tool round
 * or a new turn prefill only what is new.
 */
export function toChatMessages(messages: Message[], tools: readonly Tool[]): ChatMessage[] {
  const system = [
    ...messages.filter(m => m.role === 'system').flatMap(m => m.content).flatMap(c => (c.type === 'text' && c.text ? [c.text] : [])),
    ...(tools.length > 0 ? [toolsPrompt(tools)] : []),
  ].join('\n\n');

  const out: ChatMessage[] = [];
  const push = (role: ChatMessage['role'], content: string): void => {
    if (!content) return;
    const last = out.at(-1);
    // Adjacent turns of one role are one turn to the template; merged, so the result is the same whether
    // they arrived as one matbot message or several.
    if (last && last.role === role) last.content += `\n${content}`;
    else out.push({ role, content });
  };

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
      case 'marker':
        continue;
      case 'tool':
        push('user', msg.content.flatMap(c => c.type === 'tool-result'
          ? [`<tool_response>\n${typeof c.result === 'string' ? c.result : jsonText(c.result)}\n</tool_response>`]
          : []).join('\n'));
        continue;
      case 'user':
      case 'assistant': {
        const parts: string[] = [];
        for (const c of msg.content) {
          switch (c.type) {
            case 'text':      if (c.text) parts.push(c.text); break;
            case 'tool-call': parts.push(renderCall(c.name, c.input)); break;
            case 'document':  parts.push(textDocument(c) ?? `[Attached file: ${c.name ?? c.mimeType} — not readable by this model]`); break;
            case 'file-ref':  parts.push(`[Attached file: ${c.name}]`); break;
            case 'image':
            case 'image-url': parts.push('[Image omitted: this model does not accept images]'); break;
            case 'audio':     parts.push('[Audio omitted: this model does not accept audio]'); break;
            // A template drops earlier turns' reasoning from the prompt, so it is not replayed.
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
        push(msg.role, parts.join('\n'));
        continue;
      }
    }
  }
  return system ? [{ role: 'system', content: system }, ...out] : out;
}

export type Piece =
  | { kind: 'text';     text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'call';     name: string; arguments: unknown }
  // A call the reply ended inside — cut off by the token limit. Its arguments are unrecoverable.
  | { kind: 'cut-call'; name: string; bytes: number };

// How much of the buffer's tail to hold for the next chunk: a suffix that could still become a marker, and
// any whitespace in front of it or at the end, which belongs to the text only if more text follows.
function heldBack(s: string, markers: readonly string[]): number {
  let keep = 0;
  for (const m of markers)
    for (let k = Math.min(m.length - 1, s.length); k > keep; k--)
      if (s.endsWith(m.slice(0, k))) { keep = k; break; }
  while (keep < s.length && /\s/.test(s[s.length - keep - 1] ?? '')) keep++;
  return keep;
}

/**
 * Splits a streamed reply into prose, `<think>` reasoning and `<tool_call>` blocks as it arrives. A chunk
 * can end part-way through a marker, so a suffix that could still become one is held back until the next
 * chunk decides it. Whitespace is held the same way and trimmed at every marker, since the blank lines a
 * model writes around a call or its reasoning are layout, not something it said.
 */
export class ReplyParser {
  private buf = '';
  private mode: 'text' | 'think' | 'call' = 'text';
  // Set at every marker: the whitespace a model writes around one is layout, not content.
  private trimNext = false;

  push(chunk: string): Piece[] {
    this.buf += chunk;
    return this.drain(false);
  }

  end(): Piece[] {
    return this.drain(true);
  }

  private drain(final: boolean): Piece[] {
    const out: Piece[] = [];
    for (;;) {
      if (this.mode === 'call') {
        const at = this.buf.indexOf(CLOSE_CALL);
        if (at < 0) {
          if (final && this.buf.trim()) out.push(cutCall(this.buf));
          if (final) this.buf = '';
          return out;
        }
        out.push(parseCall(this.buf.slice(0, at)));
        this.buf = this.buf.slice(at + CLOSE_CALL.length);
        this.mode = 'text';
        this.trimNext = true;
        continue;
      }

      const markers = this.mode === 'think' ? [CLOSE_THINK] : [OPEN_CALL, OPEN_THINK];
      const kind    = this.mode === 'think' ? 'thinking' : 'text';
      if (this.trimNext) {
        this.buf = this.buf.trimStart();
        if (this.buf) this.trimNext = false;
      }
      let at = -1;
      let marker = '';
      for (const m of markers) {
        const i = this.buf.indexOf(m);
        if (i >= 0 && (at < 0 || i < at)) { at = i; marker = m; }
      }
      if (at < 0) {
        const held = final ? this.buf.length - this.buf.trimEnd().length : heldBack(this.buf, markers);
        const text = this.buf.slice(0, this.buf.length - held);
        if (text) out.push({ kind, text });
        this.buf = final ? '' : this.buf.slice(this.buf.length - held);
        return out;
      }
      const text = this.buf.slice(0, at).trimEnd();
      if (text) out.push({ kind, text });
      this.buf      = this.buf.slice(at + marker.length);
      this.mode     = marker === OPEN_CALL ? 'call' : marker === OPEN_THINK ? 'think' : 'text';
      this.trimNext = true;
    }
  }
}

function nameIn(body: string): string | undefined {
  return /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
}

function parseCall(body: string): Piece {
  try {
    const call = JSON.parse(body.trim()) as { name?: unknown; arguments?: unknown };
    if (typeof call.name === 'string') return { kind: 'call', name: call.name, arguments: call.arguments ?? {} };
  } catch { /* fall through: reported as cut, with whatever name is legible */ }
  return cutCall(body);
}

function cutCall(body: string): Piece {
  return { kind: 'cut-call', name: nameIn(body) ?? 'unknown', bytes: body.length };
}
