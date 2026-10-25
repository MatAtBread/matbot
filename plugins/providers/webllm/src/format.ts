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
  + 'within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>\n'
  // Repeated AFTER the example on purpose. Measured on Qwen3-1.7B: shown the object between the tags, it
  // copies the object verbatim — spacing and all — and drops the two XML lines around it, so the reply is
  // `{"name": "tool_search", "arguments": {…}}` and nothing else. A small model imitates what it read
  // last, and the last line of the tools block is the one it is most likely to follow.
  + 'The <tool_call> and </tool_call> tags are required: an object on its own is not a call.';

// What this adapter WRITES — into the tools' prompt, and into replayed history. The parser does not use
// these: a model writes tags as text, and not always in this exact form (see CALL_TAG below).
const OPEN_CALL   = '<tool_call>';
const CLOSE_CALL  = '</tool_call>';

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
  // A `<tool_call>` that closed, whose body is not a call the arguments can be read from. Never executed:
  // running the tool with `{}` in its place would turn a formatting slip into a real side effect. The body
  // is shown instead (see adapter.ts), so the reader sees what the model wrote and the model meets its own
  // attempt again in history, where it can correct it.
  | { kind: 'unparsed-call'; name: string | undefined; body: string }
  // The reply ended inside a call — cut off by the token limit. Its arguments are unrecoverable.
  | { kind: 'cut-call'; name: string; bytes: number };

type Mode = 'text' | 'think' | 'call';

// The tags as a model writes them, not only as this adapter writes them: whitespace before the bracket
// (`<tool_call >`), and `<toolcall>` with no underscore. The structural tag only ever produces the
// canonical form, so this is for the reply the grammar never got to constrain — which is exactly the
// reply that goes wrong.
const CALL_TAG      = { re: /<tool_?call\s*>/i,   enter: 'call'  } as const;
const END_CALL_TAG  = { re: /<\/tool_?call\s*>/i, enter: 'text'  } as const;
const THINK_TAG     = { re: /<think\s*>/i,        enter: 'think' } as const;
const END_THINK_TAG = { re: /<\/think\s*>/i,      enter: 'text'  } as const;

type Tag = { at: number; length: number; enter: Mode };
type TagPattern = { readonly re: RegExp; readonly enter: Mode };

function firstTag(s: string, tags: readonly TagPattern[]): Tag | undefined {
  let best: Tag | undefined;
  for (const { re, enter } of tags) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.at)) best = { at: m.index, length: m[0].length, enter };
  }
  return best;
}

// The tag names a model may write, for recognising the tail of one split across two chunks.
const TAG_NAMES = ['tool_call', 'toolcall', 'think'];

function isTagPrefix(tail: string): boolean {
  if (!tail.startsWith('<')) return false;
  const rest = tail.slice(tail.startsWith('</') ? 2 : 1);
  if (rest.includes('>')) return false;
  return TAG_NAMES.some(n => n.startsWith(rest.trim()));
}

// A suffix that could still become a tag, however the stream split it: `<`, `</`, `<to`, `<tool_call`,
// `<tool_call `.
function tagPrefixLen(s: string): number {
  const i = s.lastIndexOf('<');
  return i >= 0 && isTagPrefix(s.slice(i)) ? s.length - i : 0;
}

// The index just past the `}`/`]` that closes the value opening at `start`, or -1 while it is still open.
// Strings are skipped, so a brace inside an argument value cannot close it early.
function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// `arguments` given as a JSON *string* as well as an object: Qwen's own template accepts both, and the
// smaller Qwen3 builds use them for the same call. Normalised here, so a tool always receives the object
// its schema declares rather than a string it cannot read.
function normaliseCall(v: unknown): { name: string; arguments: unknown } | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const { name, arguments: args } = v as { name?: unknown; arguments?: unknown };
  if (typeof name !== 'string' || !name) return undefined;
  let input = args ?? {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input) ?? {}; } catch { /* as written: the tool reports what it got */ }
  }
  return { name, arguments: input };
}

// Worth repairing in a call's body, and only tried once a plain parse has failed: a trailing comma before
// a closing bracket, which small models write constantly. Never applied to a body that parses, so an
// argument value that legitimately contains `,}` is not rewritten.
function parseCallObject(body: string): { name: string; arguments: unknown } | undefined {
  for (const text of [body, body.replace(/,(\s*[}\]])/g, '$1')]) {
    try {
      const call = normaliseCall(JSON.parse(text.trim()));
      if (call) return call;
    } catch { /* next form */ }
  }
  return undefined;
}

function readCall(body: string): Piece | undefined {
  const call = parseCallObject(body);
  return call ? { kind: 'call', ...call } : undefined;
}

// Parallel calls may be written as a list of the same objects.
function readCalls(body: string): Piece[] | undefined {
  const one = readCall(body);
  if (one) return [one];
  try {
    const list: unknown = JSON.parse(body.trim().replace(/,(\s*[}\]])/g, '$1'));
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const pieces: Piece[] = [];
    for (const item of list) {
      const call = normaliseCall(item);
      if (!call) return undefined;
      pieces.push({ kind: 'call', ...call });
    }
    return pieces;
  } catch { return undefined; }
}

function nameIn(body: string): string | undefined {
  return /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
}

function cutCall(body: string): Piece {
  return { kind: 'cut-call', name: nameIn(body) ?? 'unknown', bytes: body.length };
}

// A `[` immediately before `i` (whitespace between) belongs to the call: parallel calls are written as a
// list, and the bracket is part of the call rather than prose. Returns the index to treat as its start.
function listStart(s: string, i: number): number {
  const m = /\[\s*$/.exec(s.slice(0, i));
  return m ? m.index : i;
}

// Where a call written with no `<tool_call>` wrapper could begin, or -1: a `{` that has only a partial
// `"name"` after it, or that opened as `{"name":` and has not closed yet. Anything else with a `{` in it
// is prose, and is emitted as prose.
function bareStart(s: string): number {
  // A list of calls begins with `[`, and that bracket is the call's own: held as soon as it is the last
  // thing in the buffer, so it cannot be emitted as prose before its calls arrive.
  const bracket = /\[\s*$/.exec(s);
  if (bracket) return bracket.index;
  // The EARLIEST `{` that could begin one, since the object's own start is what must be held: a nested
  // `{` (`"arguments": {`) would otherwise hold only the inner object and let the call's header out.
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    const tail = s.slice(i);
    // Still being written: `{`, `{"`, `{"n`, `{"name`, `{"name"`, `{"name":`.
    if (/^\{\s*(?:"(?:n(?:a(?:m(?:e(?:"\s*:?)?)?)?)?)?)?\s*$/.test(tail)) return listStart(s, i);
    // Opened as a call and not closed yet — or one of a list that has not closed. A closed call is not
    // held here: `findBareCall` reads it, or it is prose.
    if (/^\{\s*"name"\s*:/.test(tail)) {
      const from = listStart(s, i);
      if (balancedEnd(s, from) < 0) return from;
    }
  }
  return -1;
}

function barePrefixLen(s: string): number {
  const i = bareStart(s);
  return i >= 0 ? s.length - i : 0;
}

// A call the model wrote with no `<tool_call>` around it. Measured on Qwen3-1.7B, whose whole reply was an
// empty `<think>` block followed by `{"name": "tool_search", "arguments": {…}}`: it copies the call object
// its prompt shows it and drops the two tags around it, so the structural tag never fires, the parser finds
// no marker, and a complete, well-formed call arrives as JSON in a text bubble.
//
// Returns where it starts and ends as well as what it says, so any prose in front of it is emitted first.
function findBareCall(s: string): { at: number; end: number; pieces: Piece[] } | undefined {
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    if (!/^\{\s*"name"\s*:/.test(s.slice(i))) continue;
    const end = balancedEnd(s, i);
    if (end < 0) return undefined;
    const body = s.slice(i, end);
    // A call names its arguments as well as itself. Without that, `{"name": "…"}` is a JSON example in
    // prose — and running a tool from one would be a call the model never made.
    if (!/"arguments"\s*:/.test(body)) continue;
    const call = readCall(body);
    if (!call) continue;
    // A list of calls is written `[{…}, {…}]`, and the `[` is part of the call rather than prose. The
    // whole list is read at once, so its `]` is consumed with it.
    const from = listStart(s, i);
    if (from !== i) {
      const listEnd = balancedEnd(s, from);
      if (listEnd < 0) return undefined;          // still arriving; `bareStart` holds it
      const list = readCalls(s.slice(from, listEnd));
      if (list) return { at: from, end: listEnd, pieces: list };
    }
    return { at: i, end, pieces: [call] };
  }
  return undefined;
}

export interface ParserOptions {
  /**
   * Read a call written without its `<tool_call>` tags as a call (see `findBareCall`). On by default;
   * a profile turns it off with `parameters.lenientCalls: false`.
   */
  bareCalls?: boolean;
}

/**
 * Splits a streamed reply into prose, `<think>` reasoning, and `<tool_call>` blocks, as it arrives. A chunk
 * can end part-way through a marker, so a suffix that could still become one is held back until the next
 * chunk decides it. Whitespace is held the same way and trimmed at every marker, since the blank lines a
 * model writes around a call or its reasoning are layout, not something it said.
 *
 * A call that will not parse is not a call with no arguments — it is unreadable, and reported as such
 * rather than executed.
 */
export class ReplyParser {
  private buf = '';
  private mode: Mode = 'text';
  // Set at every marker: the whitespace a model writes around one is layout, not content.
  private trimNext = false;
  private readonly lenient: boolean;

  constructor(options: ParserOptions = {}) {
    this.lenient = options.bareCalls !== false;
  }

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
        const close = firstTag(this.buf, [END_CALL_TAG]);
        if (!close) {
          if (!final) return out;
          const body = this.buf;
          this.buf = '';
          if (!body.trim()) return out;
          // Ended inside a call. A body that still parses is a call whose closing tag is what got cut;
          // anything else was severed mid-argument, and its arguments are unrecoverable.
          out.push(readCall(body) ?? cutCall(body));
          return out;
        }
        const body = this.buf.slice(0, close.at);
        // A closed tag whose body will not parse is NOT a call with empty arguments: shown, not run.
        out.push(readCall(body) ?? { kind: 'unparsed-call', name: nameIn(body), body });
        this.buf      = this.buf.slice(close.at + close.length);
        this.mode     = 'text';
        this.trimNext = true;
        continue;
      }

      const kind: Piece['kind'] = this.mode === 'think' ? 'thinking' : 'text';
      if (this.trimNext) {
        this.buf = this.buf.trimStart();
        if (this.buf) this.trimNext = false;
      }
      const tag = firstTag(this.buf, this.mode === 'think'
        // A call ends reasoning. Qwen3 opens ` thinking` and, once it decides to call a tool, writes the
        // call without closing the block — vLLM's own Qwen3 parser treats `<tool_call>` as the implicit end
        // of reasoning for that reason. Without this the whole call arrives as thinking: invisible when
        // thinking is off, and "reasoned, then forgot to call" when it is on.
        ? [END_THINK_TAG, CALL_TAG]
        : [CALL_TAG, THINK_TAG]);
      const bare = this.lenient ? findBareCall(this.buf) : undefined;
      const at   = tag && (!bare || tag.at <= bare.at) ? tag.at : bare?.at ?? -1;

      if (at < 0) {
        const held = final ? this.buf.length - this.buf.trimEnd().length : this.hold();
        const text = this.buf.slice(0, this.buf.length - held);
        if (text) out.push({ kind, text });
        this.buf = final ? '' : this.buf.slice(this.buf.length - held);
        return out;
      }
      const text = this.buf.slice(0, at).trimEnd();
      if (text) out.push({ kind, text });
      if (tag && at === tag.at) {
        this.buf  = this.buf.slice(at + tag.length);
        this.mode = tag.enter;
      } else {
        out.push(...bare!.pieces);
        this.buf = this.buf.slice(bare!.end);
        // A bare call ends reasoning too: a model that never closed `<think>` was not going to.
        this.mode = 'text';
      }
      this.trimNext = true;
    }
  }

  private hold(): number {
    let keep = Math.max(tagPrefixLen(this.buf), this.lenient ? barePrefixLen(this.buf) : 0);
    while (keep < this.buf.length && /\s/.test(this.buf[this.buf.length - keep - 1] ?? '')) keep++;
    return keep;
  }
}
