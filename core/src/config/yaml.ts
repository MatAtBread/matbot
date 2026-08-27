/**
 * Minimal YAML parser for matbot config files.
 *
 * Supports:
 *   - Nested block mappings (key: value / key: followed by indented block)
 *   - Block sequences (- item), including an item whose value is an indented block under a bare `-`
 *   - Scalar types: string, number, boolean, null
 *   - Quoted strings (single and double), as values and as keys
 *   - Comments (# ...)
 *
 * Does NOT support anchors, aliases, flow syntax, or ${NAME} expansion.
 * ${NAME} placeholders are left intact for the Vault to resolve.
 * Supports literal block scalars (|) and folded block scalars (>).
 *
 * Deliberately NOT supported: YAML's compact mapping in a sequence entry (`- key: value` with the
 * mapping starting on the dash's own line). It is legal YAML, but telling it from a plugin specifier
 * needs the spec's rule that a key separator is a colon followed by SPACE or end-of-line — without
 * which `- https://host/plugin.ts` parses as the key `https`. This tokenizer works on the first colon
 * in a line, so the compact form is rejected (below) rather than guessed at.
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
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const stripped = lines[n]!.replace(/#.*$/, '').trimEnd();
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    tokens.push({ indent, raw: stripped.trimStart(), line: n + 1 });
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

// A sequence item is `- value`, or a bare `-` whose value is the block indented beneath it.
function isSeqItem(raw: string): boolean {
  return raw === '-' || raw.startsWith('- ');
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
        items.push(parseScalar(itemRaw));
        i++;
      }
    }
    return { value: items, next: i };
  }

  if (first.raw.includes(':')) {
    const map: YamlMap = {};
    let i = pos;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.indent < baseIndent) break;
      if (!tok.raw.includes(':')) fail(tok, 'a mapping was expected here (no "key:").');

      const colonIdx = tok.raw.indexOf(':');
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
      } else if (rest === '') {
        const sub = parse(tokens, i + 1, tok.indent + 2);
        map[key]  = sub.value;
        i         = sub.next;
      } else {
        map[key] = parseScalar(rest);
        i++;
      }
    }
    return { value: map, next: i };
  }

  return { value: parseScalar(first.raw), next: pos + 1 };
}

export function parseYaml(text: string): YamlMap {
  const tokens = tokenize(text);
  if (tokens.length === 0) return {};
  const { value } = parse(tokens, 0, 0);
  return (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? value as YamlMap
    : {};
}
