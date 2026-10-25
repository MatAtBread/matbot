import type { Message, MessageContent, Tool } from '@matatbread/matbot-plugin-api';

// Tool calling for an endpoint that has none: the tools are described in the system prompt, in the
// `<tools>` / `<tool_call>` format Qwen and Hermes are trained on, and calls are parsed out of the reply
// text. Measured against Llama 3.1 8B here, that format did better than Llama's own (`Environment:
// ipython`, bare `{"name", "parameters"}`), which it decorated with `"type": "function"`, moved the name
// into `function`, and trailed with Python. Everything below is tuned to that model and this endpoint, and
// is deliberately not shared with webllm's version of the same idea: the two models fail differently.

const TOOLS_PREAMBLE = '# Tools\n\nYou may call a function to help answer the user.\n\n'
  + 'You are provided with function signatures within <tools></tools> XML tags:\n<tools>';
const TOOLS_POSTAMBLE = '</tools>\n\nTo call a function, return a json object with function name and arguments '
  + 'within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>\n'
  + 'The <tool_call> and </tool_call> tags are required: an object on its own is not a call.\n\n'
  // Nothing stops the model after a call: the endpoint ignores `stop`, and without this it went on to
  // invent further calls, and once their results. The parser keeps only the first `maxCalls` anyway.
  + 'Write one <tool_call> and then stop: its result comes back to you in a <tool_response> in the next message. '
  + 'When a <tool_response> already answers the question, reply to the user in plain text without calling a function. '
  + 'Only call a function when the request needs one.';

const OPEN_CALL  = '<tool_call>';
const CLOSE_CALL = '</tool_call>';

function objectSchema(schema: unknown): object {
  return { ...(schema as object), type: 'object' };
}

function firstParagraph(text: string, max: number): string {
  const para = text.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ') ?? '';
  return para.length > max ? `${para.slice(0, max - 1).trimEnd()}…` : para;
}

// A sentence ends where the next one visibly starts, so `e.g.` and `i.e.` do not end one.
function firstSentence(text: string, max: number): string {
  const sentence = /^[\s\S]*?[.!?](?=\s+[A-Z(`"]|\s*$)/.exec(text.trim())?.[0] ?? text.trim();
  return firstParagraph(sentence, max);
}

// Every `description` inside a schema cut to its first sentence; the structure — keys, types, enums,
// required — is kept whole, being what a call has to satisfy.
function compactSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compactSchema);
  if (typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) =>
    [k, k === 'description' && typeof x === 'string' ? firstSentence(x, 120) : compactSchema(x)]));
}

export interface ToolsPromptOptions {
  /** Each description cut to its first paragraph, and the schema's to their first sentence. */
  compact?: boolean;
  /** Offered tools left out of the list to fit the window. */
  hidden?: number;
}

export function toolsPrompt(tools: readonly Tool[], options: ToolsPromptOptions = {}): string {
  const lines = tools.map(t => JSON.stringify({
    type: 'function',
    function: options.compact
      ? { name: t.name, description: firstParagraph(t.description, 300), parameters: compactSchema(objectSchema(t.inputSchema)) }
      : { name: t.name, description: t.description, parameters: objectSchema(t.inputSchema) },
  }));
  // Only worth saying where the model can do something about it.
  const more = options.hidden && tools.some(t => t.name === 'tool_search')
    ? `\n\n${options.hidden} more tool${options.hidden === 1 ? ' is' : 's are'} available but not listed here; tool_search finds them.`
    : '';
  return `${TOOLS_PREAMBLE}\n${lines.join('\n')}\n${TOOLS_POSTAMBLE}${more}`;
}

function jsonText(v: unknown): string {
  try { return JSON.stringify(v) ?? 'null'; } catch { return String(v); }
}

function renderCall(name: string, input: unknown): string {
  return `${OPEN_CALL}\n{"name": ${JSON.stringify(name)}, "arguments": ${jsonText(input ?? {})}}\n${CLOSE_CALL}`;
}

// A bare `<tool_response>` is read as the user's own words, and answered as such: the model called another
// tool, often an unrelated one, or wrote about the result — "it seems I've loaded 9 tools" — rather than
// acting on it. So it is said whose result it is, the question is put again, and the two ways on are named.
// Measured on matbot's own turns: with "answer the user's question with it" alone, the model answered THAT,
// advising someone on how they could reply. With the question restated it made the call the result pointed
// to every time. The endpoint's `ipython` role was accepted and then ignored.
function renderResults(results: Array<{ name: string | undefined; text: string; isError: boolean }>, question: string | undefined): string {
  const blocks = results.map(r => `<tool_response>\n${r.text}\n</tool_response>`).join('\n');
  const names  = [...new Set(results.map(r => r.name ?? 'function'))].join(', ');
  const failed = results.some(r => r.isError);
  const asked  = question ? `The user asked: "${question.length > 300 ? `${question.slice(0, 299)}…` : question}"\n` : '';
  return `${blocks}\nThat is the result of your ${names} call${results.length === 1 ? '' : 's'}`
    + `${failed ? ', which reported an error' : ''}.\n${asked}`
    + 'Use this result: call the next function you need with a <tool_call>, or answer the user.';
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

function texts(content: readonly MessageContent[]): string[] {
  return content.flatMap(c => (c.type === 'text' && c.text ? [c.text] : []));
}

function shorten(text: string, max: number | undefined): string {
  if (max === undefined || text.length <= max) return text;
  return `${text.slice(0, max)}\n[… ${text.length - max} more characters left out to fit the context window]`;
}

export interface RenderOptions extends ToolsPromptOptions {
  /** The tools described. With none, and none `offered`, history is text only. */
  tools: readonly Tool[];
  /** Tools were offered at all — so calls in history are replayed, even if `tools` is now empty. */
  offered: boolean;
  /** Index of the first non-system message kept; the ones before it are left out. */
  from?: number;
  /** Caps on a replayed tool result: the latest tool message, and every one before it. */
  latestResultChars?: number;
  olderResultChars?: number;
}

/**
 * matbot's history as the endpoint's messages plus its one system string. With tools offered, an
 * assistant's calls are replayed as `<tool_call>` blocks after its text, and tool results as framed
 * `<tool_response>` user turns. Without, history is text only, as it always was: replayed call syntax with
 * no tools prompt to explain it would only teach the model to write calls that are never read.
 */
export function toChatMessages(messages: readonly Message[], options: RenderOptions): { systemPrompt: string; messages: ChatMessage[] } {
  const from    = options.from ?? 0;
  const omitted = messages.slice(0, from).filter(m => m.role !== 'system' && m.role !== 'marker').length;
  // Several system messages are possible (a caller's own plus one the harness prepends), and the endpoint
  // takes a single string, so they are joined in arrival order rather than one kept.
  const systemPrompt = [
    ...messages.filter(m => m.role === 'system').flatMap(m => texts(m.content)),
    ...(omitted > 0 ? [`(The ${omitted} earliest message${omitted === 1 ? ' of this conversation is' : 's of this conversation are'} left out to fit the context window.)`] : []),
    ...(options.tools.length > 0 ? [toolsPrompt(options.tools, options)] : []),
  ].join('\n\n');

  let latestTool = -1;
  messages.forEach((m, i) => { if (m.role === 'tool') latestTool = i; });

  const callNames = new Map<string, string>();
  let question: string | undefined;
  const out: ChatMessage[] = [];
  const push = (role: ChatMessage['role'], content: string): void => {
    if (!content) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content += `\n${content}`;
    else out.push({ role, content });
  };

  messages.forEach((msg, i) => {
    if (i < from) {
      // Names are still learnt from what is left out, for a result whose call was.
      for (const c of msg.content) if (c.type === 'tool-call') callNames.set(c.id, c.name);
      if (msg.role === 'user') question = texts(msg.content).join('\n') || question;
      return;
    }
    switch (msg.role) {
      case 'system':
      case 'marker':
        return;
      case 'tool': {
        if (!options.offered) return;
        const max = i === latestTool ? options.latestResultChars : options.olderResultChars;
        const results = msg.content.flatMap(c => c.type === 'tool-result'
          ? [{ name: callNames.get(c.id), text: shorten(typeof c.result === 'string' ? c.result : jsonText(c.result), max), isError: c.isError === true }]
          : []);
        if (results.length > 0) push('user', renderResults(results, question));
        return;
      }
      case 'user':
      case 'assistant': {
        const parts: string[] = [];
        for (const c of msg.content) {
          if (c.type === 'text' && c.text) parts.push(c.text);
          else if (c.type === 'tool-call' && options.offered) {
            callNames.set(c.id, c.name);
            parts.push(renderCall(c.name, c.input));
          }
        }
        if (msg.role === 'user') question = texts(msg.content).join('\n') || question;
        push(msg.role, parts.join('\n'));
        return;
      }
    }
  });
  return { systemPrompt, messages: out };
}

export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'call'; name: string; arguments: object }
  // A closed `<tool_call>` whose body is not a call with readable object arguments — including
  // `"arguments": "ls /tmp"`, which this model writes. Shown, never run: a tool invoked on arguments the
  // model never gave turns a formatting slip into a side effect.
  | { kind: 'unparsed-call'; name: string | undefined; body: string }
  // The reply ended inside a call: cut off at the token limit, arguments unrecoverable.
  | { kind: 'cut-call'; name: string; bytes: number };

export interface Parsed {
  pieces:  Piece[];
  // Calls (and anything after them) beyond `maxCalls`, dropped.
  dropped: string;
}

const CALL_TAG     = /<tool_?call\s*>/i;
const END_CALL_TAG = /<\/tool_?call\s*>/i;

// The opening tag nearest a closing one. The model writes the tag into its prose as well as around its
// call — "Let me call it with a<tool_call>\nto get a description", then the call itself — and paired with
// the first opening tag, the call's body was that sentence plus the call, which reads as no call at all.
function lastOpen(s: string): { index: number; end: number } | undefined {
  let found: { index: number; end: number } | undefined;
  for (const m of s.matchAll(new RegExp(CALL_TAG.source, 'gi'))) found = { index: m.index, end: m.index + m[0].length };
  return found;
}

// The model fences its call as code (```` ``` ```` on the lines around it), which left an opening fence
// hanging at the end of the prose before it, and a closing one at the start of whatever followed.
function unfence(s: string, beforeCall: boolean, afterCall: boolean): string {
  let t = s;
  if (beforeCall) t = t.replace(/(?:^|\n)[ \t]*```[\w-]*[ \t]*\s*$/, '');
  if (afterCall)  t = t.replace(/^\s*```[ \t]*(?:\n|$)/, '');
  return t;
}

// The index just past the `}` that closes the object opening at `start`, or -1 while it is still open.
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

function readCall(body: string): Extract<Piece, { kind: 'call' }> | undefined {
  // Trailing commas are repaired only once a plain parse has failed, so a value containing `,}` survives.
  for (const text of [body, body.replace(/,(\s*[}\]])/g, '$1')]) {
    let v: unknown;
    try { v = JSON.parse(text.trim()); } catch { continue; }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    // A function's signature, not a call to it: the model, explaining tools instead of using them, writes
    // listings shaped like its own prompt's — and through the `parameters` fallback below, an invented tool
    // was run with a JSON schema for its arguments.
    if ('description' in v) return undefined;
    const { name, arguments: args, parameters } = v as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof name !== 'string' || !name) return undefined;
    // `parameters` is Llama's own key for the same thing, and it falls back to it.
    let input = args ?? parameters ?? {};
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { return undefined; }
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
    if ((input as { type?: unknown }).type === 'object' && 'properties' in input) return undefined;
    return { kind: 'call', name, arguments: input };
  }
  return undefined;
}

function nameIn(body: string): string | undefined {
  return /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
}

// A call written with no `<tool_call>` around it: `{"name": …}` and balanced. Prose with braces in it that
// does not open that way is left as prose.
// Spans of the reply that are the model writing a tool listing or a result of its own — documentation or
// imagination, and never a call, whatever objects are in them. An unclosed one runs to the end.
function quoted(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of s.matchAll(/<(tools|tool_response)\s*>/gi)) {
    const close = new RegExp(`</${m[1]}\\s*>`, 'i').exec(s.slice(m.index));
    spans.push([m.index, close ? m.index + close.index + close[0].length : s.length]);
  }
  return spans;
}

function findBareCall(s: string): { at: number; end: number; call: Extract<Piece, { kind: 'call' }> } | undefined {
  const spans = quoted(s);
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    if (spans.some(([a, b]) => i >= a && i < b)) continue;
    if (!/^\{\s*"name"\s*:/.test(s.slice(i))) continue;
    const end = balancedEnd(s, i);
    if (end < 0) return undefined;
    const call = readCall(s.slice(i, end));
    if (call) return { at: i, end, call };
  }
  return undefined;
}

export interface ParseOptions {
  /** How many calls of one reply are kept. The rest of the reply after the last kept call is dropped. */
  maxCalls: number;
  /** Read a call written without its tags as a call. */
  bareCalls: boolean;
}

/**
 * Splits a whole reply into prose and calls. The endpoint does not stream, so this sees the reply at once.
 *
 * Only the first `maxCalls` calls are kept, and everything after the last of them is dropped: with nothing
 * to end generation at a call, the model writes on past it — further calls it has no results for yet,
 * mostly invented (asked to list a directory, one `bash` call and then eight weather lookups for US
 * cities), and sometimes its own guess at the result. What follows a call is not something it said.
 */
export function parseReply(reply: string, options: ParseOptions): Parsed {
  const pieces: Piece[] = [];
  let calls = 0;
  let rest  = reply;
  const text = (s: string, beforeCall: boolean): void => {
    const t = unfence(s, beforeCall, calls > 0).trim();
    if (t) pieces.push({ kind: 'text', text: t });
  };

  while (rest) {
    // A closing fence alone is the end of the call's own formatting, not something dropped.
    if (calls >= options.maxCalls) return { pieces, dropped: unfence(rest, false, true).trim() ? rest.trim() : '' };
    const tag  = CALL_TAG.exec(rest);
    const bare = options.bareCalls ? findBareCall(rest) : undefined;
    if (!tag && !bare) { text(rest, false); break; }

    if (bare && (!tag || bare.at < tag.index)) {
      text(rest.slice(0, bare.at), true);
      pieces.push(bare.call);
      calls++;
      rest = rest.slice(bare.end);
      continue;
    }

    const open  = tag!;
    let   prose = rest.slice(0, open.index);
    let   after = rest.slice(open.index + open[0].length);
    const close = END_CALL_TAG.exec(after);
    // Any opening tag before the close makes the earlier one prose; the tag itself is dropped from it.
    const inner = lastOpen(close ? after.slice(0, close.index) : after);
    if (inner) {
      prose += after.slice(0, inner.index);
      after  = after.slice(inner.end);
    }
    const end = END_CALL_TAG.exec(after);
    // An unclosed tag with prose after it is the tag mentioned, not a call begun ("wrap your request in
    // <tool_call> tags."). Only a body that opens as an object can be a call the reply ended inside.
    if (!end && !after.trimStart().startsWith('{')) { text(prose + after, false); break; }
    text(prose, true);
    if (!end) {
      // Ended inside a call. A body that still parses lost only its closing tag.
      if (after.trim()) pieces.push(readCall(after) ?? { kind: 'cut-call', name: nameIn(after) ?? 'unknown', bytes: after.length });
      break;
    }
    const body = after.slice(0, end.index);
    pieces.push(readCall(body) ?? { kind: 'unparsed-call', name: nameIn(body), body: body.trim() });
    calls++;
    rest = after.slice(end.index + end[0].length);
  }
  return { pieces, dropped: '' };
}
