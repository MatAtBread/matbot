/**
 * Minimal YAML parser for matbot config files.
 *
 * Supports:
 *   - Nested block mappings (key: value / key: followed by indented block)
 *   - Block sequences (- item), including an item whose value is an indented block under a bare `-`
 *   - Scalar types: string, number, boolean, null
 *   - Quoted strings (single and double), as values and as keys
 *   - Flow collections as a value or a sequence item — `[a, b]`, `{ k: v }`, nested, and spanning lines
 *     until the brackets close (see parseFlow)
 *   - Comments (# ...), outside quotes and at a line start or after whitespace (see stripComment)
 *
 * Does NOT support anchors, aliases, or ${NAME} expansion.
 * ${NAME} placeholders are left intact for the Vault to resolve.
 * Supports literal block scalars (|) and folded block scalars (>).
 *
 * Deliberately NOT supported: YAML's compact mapping in a sequence entry (`- key: value` with the
 * mapping starting on the dash's own line). It is legal YAML, but telling it from a plugin specifier
 * needs the spec's rule that a key separator is a colon followed by SPACE or end-of-line — without
 * which `- https://host/plugin.ts` parses as the key `https` — so the compact form is rejected (below)
 * rather than guessed at. A key itself is found by that rule ({@link keyEnd}): it once ended at the first
 * colon in the line, quoted or not, so `'deny:tool_function.import':` became the key `'deny`, and every
 * configured denial — whose key always has that shape — was unwritable, with nothing reporting it.
 *
 * An unparseable construct THROWS naming the line. It used to `break` the enclosing loop, which
 * returned what had been read so far and left the rest of the document silently discarded — a stray
 * `-` in `plugins:` dropped every plugin after it and every top-level section below it, including
 * `providers:`, with no error. A config parser that returns a subset of the file the user wrote is
 * worse than one that fails: the failure is one message, the subset is an install that boots and
 * behaves as though half its configuration were never written.
 */

type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | YamlMap;
export type YamlMap   = { [key: string]: YamlValue };

interface Token {
  indent: number;
  raw:    string;
  line:   number;
  /** The last line it spans: a flow collection continues until its brackets close. */
  end:    number;
}

// Where a `#` opens a comment, per YAML's own rule: outside a quoted scalar, and at the start of a
// line or after whitespace. Stripping every `#` truncated values that legitimately contain one —
// `github:owner/repo#path:sub` lost its subdirectory, and a quoted value lost everything from the `#`
// on, INCLUDING its closing quote, so it then failed to unquote and kept a stray `"`. Both were silent.
//
// A quote only opens a quoted scalar where a scalar can start (line start, or after the `:`/`-` that
// introduces a value); elsewhere it is an apostrophe in a plain scalar (`title: Matt's config`), and
// treating it as an opening quote would swallow a real trailing comment.
//
// Still unhandled, as before: a `#` inside a block scalar (`|`/`>`) body, and a backslash-escaped quote
// — this parser does not process escapes anywhere (see `unquote`).
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if ((ch === '"' || ch === "'") && opensScalar(line, i)) { quote = ch; continue; }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i);
  }
  return line;
}

// Is position `i` somewhere a scalar can begin — nothing but whitespace before it, or the `:`/`-` that
// introduces one, or the `[`/`{`/`,` that opens or separates a flow entry? Keys count: `'@scope/pkg':` is
// a quoted scalar at line start.
function opensScalar(line: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const ch = line[j]!;
    if (ch === ' ' || ch === '\t') continue;
    return ch === ':' || ch === '-' || ch === '[' || ch === '{' || ch === ',';
  }
  return true;
}

/**
 * Where `raw`'s key ends — the index of its separating colon — or -1 when `raw` is not `key: …`. A quoted
 * key ends at its closing quote, whatever it contains; a plain one at the first colon followed by a space or
 * the end of the line, which is YAML's rule, so `https://host` and `node:fs` are not keys.
 */
function keyEnd(raw: string): number {
  const q = raw[0];
  if (q === '"' || q === "'") {
    const close = raw.indexOf(q, 1);
    if (close < 0) return -1;
    let j = close + 1;
    while (raw[j] === ' ' || raw[j] === '\t') j++;
    return raw[j] === ':' && separates(raw, j) ? j : -1;
  }
  for (let j = raw.indexOf(':'); j >= 0; j = raw.indexOf(':', j + 1)) if (separates(raw, j)) return j;
  return -1;
}

const separates = (raw: string, colon: number): boolean =>
  colon + 1 === raw.length || raw[colon + 1] === ' ' || raw[colon + 1] === '\t';

// What follows a key or a sequence dash on a token's line; '' for anything else.
function valueOf(raw: string): string {
  if (isSeqItem(raw)) return raw.slice(1).trim();
  const k = keyEnd(raw);
  return k < 0 ? '' : raw.slice(k + 1).trim();
}

// How many flow brackets `value` leaves open; 0 when it is not a flow collection.
function openFlow(value: string): number {
  if (value[0] !== '[' && value[0] !== '{') return 0;
  let depth = 0;
  let quote: string | undefined;
  for (const ch of value) {
    if (quote !== undefined) { if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split('\n');
  // The indent of a `key: |` or `key: >` whose body is being read: its lines are text, never flow, however
  // they start — `Note: [see below` in a prompt must not swallow the lines after it.
  let blockOf: number | undefined;
  for (let n = 0; n < lines.length; n++) {
    const stripped = stripComment(lines[n]!).trimEnd();
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    const line   = n + 1;
    let raw = stripped.trimStart();
    if (blockOf !== undefined && indent > blockOf) { tokens.push({ indent, raw, line, end: line }); continue; }
    blockOf = undefined;
    // A flow collection runs on to the line its brackets close on, as one token.
    while (openFlow(valueOf(raw)) > 0 && n + 1 < lines.length) {
      n++;
      const more = stripComment(lines[n]!).trim();
      if (more !== '') raw += ` ${more}`;
    }
    const value = valueOf(raw);
    if (value === '|' || value === '>') blockOf = indent;
    tokens.push({ indent, raw, line, end: n + 1 });
  }
  return tokens;
}

function fail(tok: Token, what: string): never {
  throw new Error(`Config: could not parse line ${tok.line} ("${tok.raw}") — ${what}`);
}

function unquote(raw: string): string {
  return (raw.length > 1 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))))
    ? raw.slice(1, -1)
    : raw;
}

function parseScalar(raw: string): YamlScalar {
  const unquoted = unquote(raw);
  if (unquoted !== raw) return unquoted;

  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true')  return true;
  if (raw === 'false') return false;

  const num = Number(raw);
  if (!Number.isNaN(num) && raw !== '') return num;

  return raw;
}

/**
 * A flow collection — `[a, b]`, `{ k: v }`, nested — read whole from `text`. A quoted scalar is taken to its
 * closing quote, with no escapes processed (as {@link unquote}); a plain one ends at the next `,`, `]` or
 * `}`, and a key also at a colon followed by a space or one of those. A plain value may contain a colon, so
 * `['* node:fs']` and `[https://host/x.ts]` read as written. Anything malformed fails, naming the line: a
 * flow value read as a string was the failure this exists to end, the gate's standing answers written as
 * `{ '*': [a, b] }` having been silently no answer at all.
 */
function parseFlow(tok: Token, text: string): YamlValue {
  let i = 0;
  const skip = (): void => { while (text[i] === ' ' || text[i] === '\t') i++; };
  const broken = (what: string): never => fail(tok, `${what} in the flow collection "${text}", at "${text.slice(i, i + 20)}".`);
  const scalar = (key: boolean): YamlScalar => {
    skip();
    const q = text[i];
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, i + 1);
      if (close < 0) broken('a quoted string is not closed');
      const quoted = text.slice(i + 1, close);
      i = close + 1;
      return quoted;
    }
    const start = i;
    while (i < text.length && !',]}'.includes(text[i]!)
           && !(key && text[i] === ':' && (i + 1 === text.length || ' \t,]}'.includes(text[i + 1]!)))) i++;
    const plain = text.slice(start, i).trim();
    if (plain === '') broken('an entry is empty');
    return key ? plain : parseScalar(plain);
  };
  const value = (): YamlValue => {
    skip();
    if (text[i] === '[') return sequence();
    if (text[i] === '{') return mapping();
    return scalar(false);
  };
  // After an entry: `,` for another, or the closing bracket. A trailing comma is allowed, as YAML has it.
  const next = (close: string): boolean => {
    skip();
    if (text[i] === ',') { i++; skip(); if (text[i] !== close) return true; }
    if (text[i] === close) { i++; return false; }
    return broken(`"," or "${close}" was expected`);
  };
  const sequence = (): YamlValue[] => {
    i++;
    const items: YamlValue[] = [];
    skip();
    if (text[i] === ']') { i++; return items; }
    do items.push(value()); while (next(']'));
    return items;
  };
  const mapping = (): YamlMap => {
    i++;
    const map: YamlMap = {};
    skip();
    if (text[i] === '}') { i++; return map; }
    do {
      const key = String(scalar(true));
      skip();
      if (text[i] !== ':') broken(`":" was expected after the key "${key}"`);
      i++;
      skip();
      map[key] = text[i] === ',' || text[i] === '}' ? null : value();
    } while (next('}'));
    return map;
  };
  const parsed = value();
  skip();
  if (i < text.length) broken('there is more after the collection closes');
  return parsed;
}

const isFlow = (raw: string): boolean => raw[0] === '[' || raw[0] === '{';

// A sequence item is `- value`, or a bare `-` whose value is the block indented beneath it.
function isSeqItem(raw: string): boolean {
  return raw === '-' || raw.startsWith('- ');
}

// Does `next` start the value of the bare `key:` at `tok` — indented beneath it, or a flush-left sequence?
function opensBlock(tok: Token, next: Token | undefined): boolean {
  return next !== undefined && (next.indent > tok.indent || (next.indent === tok.indent && isSeqItem(next.raw)));
}

function parse(tokens: Token[], pos: number, baseIndent: number): { value: YamlValue; next: number } {
  if (pos >= tokens.length) return { value: null, next: pos };

  const first = tokens[pos]!;

  if (isSeqItem(first.raw)) {
    const items: YamlValue[] = [];
    let i = pos;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.indent < first.indent) break;
      // A sibling key at the sequence's own indent ends it — the flush-left style, where `plugins:`
      // and its `-` items share a column, is legal and common.
      if (tok.indent === first.indent && !isSeqItem(tok.raw)) break;
      if (tok.indent > first.indent) {
        fail(tok, 'it is indented further than the sequence item above it. A mapping inside a ' +
                  'sequence entry must start on its own line, under a bare "-".');
      }
      const itemRaw = tok.raw === '-' ? '' : tok.raw.slice(2).trim();
      if (itemRaw === '') {
        // `-` alone: its value is the block indented beneath it, or null if there is no such block.
        const next = tokens[i + 1];
        if (next === undefined || next.indent <= tok.indent) {
          items.push(null);
          i++;
        } else {
          const sub = parse(tokens, i + 1, tok.indent + 2);
          items.push(sub.value);
          i = sub.next;
        }
      } else {
        items.push(isFlow(itemRaw) ? parseFlow(tok, itemRaw) : parseScalar(itemRaw));
        i++;
      }
    }
    return { value: items, next: i };
  }

  if (keyEnd(first.raw) >= 0) {
    const map: YamlMap = {};
    let i = pos;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.indent < baseIndent) break;
      const colonIdx = keyEnd(tok.raw);
      if (colonIdx < 0) {
        fail(tok, 'a mapping was expected here (no "key:" — a key is followed by ": ", or ":" at the end of ' +
                  'the line, and one containing ": " is quoted).');
      }

      const key      = unquote(tok.raw.slice(0, colonIdx).trim());
      const rest     = tok.raw.slice(colonIdx + 1).trimStart();

      if (rest === '|' || rest === '>') {
        const blockIndent = tok.indent + 2;
        const lines: string[] = [];
        let j = i + 1;
        while (j < tokens.length && tokens[j]!.indent >= blockIndent) {
          const t = tokens[j]!;
          lines.push(' '.repeat(t.indent - blockIndent) + t.raw);
          j++;
        }
        map[key] = rest === '|'
          ? lines.join('\n') + (lines.length > 0 ? '\n' : '')
          : lines.join(' ');
        i = j;
      } else if (rest === '' && !opensBlock(tok, tokens[i + 1])) {
        // `key:` with nothing beneath it is null, as YAML has it. Parsed as a block, the next sibling
        // ended it at once and the key read as an empty MAPPING, so an emptied `plugins:` failed boot.
        map[key] = null;
        i++;
      } else if (rest === '') {
        const sub = parse(tokens, i + 1, tok.indent + 2);
        map[key]  = sub.value;
        i         = sub.next;
      } else {
        map[key] = isFlow(rest) ? parseFlow(tok, rest) : parseScalar(rest);
        i++;
      }
    }
    return { value: map, next: i };
  }

  return { value: isFlow(first.raw) ? parseFlow(first, first.raw) : parseScalar(first.raw), next: pos + 1 };
}

/** Where a top-level key's block sequence lies in `text`, for an editor that changes the list in place
 *  rather than reprinting the file and losing its comments. Lines are indexes into `text.split('\n')`.
 *  `items` are the sequence's own entries, with the value the parser reads from each; `end` is the last
 *  line belonging to the sequence (an item's nested block included), so an append goes after it. */
export interface SequenceLocation {
  keyLine: number;
  /** What follows the key on its own line, comment stripped: '' for a block sequence or an empty key. */
  inline:  string;
  items:   { line: number; value: YamlValue }[];
  end:     number;
}

export function locateSequence(text: string, key: string): SequenceLocation | undefined {
  const tokens = tokenize(text);
  const at = tokens.findIndex(t => t.indent === 0 && !isSeqItem(t.raw) && keyEnd(t.raw) >= 0
    && unquote(t.raw.slice(0, keyEnd(t.raw)).trim()) === key);
  const keyTok = tokens[at];
  if (keyTok === undefined) return undefined;
  const location: SequenceLocation = {
    keyLine: keyTok.line - 1,
    inline:  valueOf(keyTok.raw),
    items:   [],
    end:     keyTok.end - 1,
  };
  const first = tokens[at + 1];
  if (location.inline !== '' || first === undefined || !isSeqItem(first.raw)) return location;
  // The same boundary `parse` draws: a shallower token, or a non-item at the items' own column.
  for (let i = at + 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.indent < first.indent || (tok.indent === first.indent && !isSeqItem(tok.raw))) break;
    if (tok.indent === first.indent) {
      const raw = tok.raw === '-' ? '' : tok.raw.slice(2).trim();
      location.items.push({ line: tok.line - 1, value: raw === '' ? null : isFlow(raw) ? parseFlow(tok, raw) : parseScalar(raw) });
    }
    location.end = tok.end - 1;
  }
  return location;
}

export function parseYaml(text: string): YamlMap {
  const tokens = tokenize(text);
  if (tokens.length === 0) return {};
  const { value } = parse(tokens, 0, 0);
  // A document that is not a mapping was returned as `{}`: every key in it silently unread — which is what a
  // first line of `key:value` (no space, so no key) would now otherwise do.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(tokens[0]!, 'the file must be a mapping of keys ("key: value").');
  }
  return value;
}
