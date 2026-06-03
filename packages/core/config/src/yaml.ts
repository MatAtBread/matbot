/**
 * Minimal YAML parser for matbot config files.
 *
 * Supports:
 *   - Nested block mappings (key: value / key: followed by indented block)
 *   - Block sequences (- item)
 *   - Scalar types: string, number, boolean, null
 *   - Quoted strings (single and double)
 *   - Comments (# ...)
 *
 * Does NOT support anchors, aliases, flow syntax, or ${env:} expansion.
 * ${env:NAME} and ${secret:name} placeholders are left intact for the Vault to resolve.
 * Supports literal block scalars (|) and folded block scalars (>).
 */

type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | YamlMap;
export type YamlMap   = { [key: string]: YamlValue };

interface Token {
  indent: number;
  raw:    string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const line of text.split('\n')) {
    const stripped = line.replace(/#.*$/, '').trimEnd();
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    tokens.push({ indent, raw: stripped.trimStart() });
  }
  return tokens;
}

function parseScalar(raw: string): YamlScalar {
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true')  return true;
  if (raw === 'false') return false;

  const num = Number(raw);
  if (!Number.isNaN(num) && raw !== '') return num;

  return raw;
}

function parse(tokens: Token[], pos: number, baseIndent: number): { value: YamlValue; next: number } {
  if (pos >= tokens.length) return { value: null, next: pos };

  const first = tokens[pos]!;

  if (first.raw.startsWith('- ')) {
    const items: YamlValue[] = [];
    let i = pos;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.indent < first.indent) break;
      if (tok.indent === first.indent && tok.raw.startsWith('- ')) {
        const itemRaw = tok.raw.slice(2).trim();
        if (itemRaw === '') {
          const sub = parse(tokens, i + 1, tok.indent + 2);
          items.push(sub.value);
          i = sub.next;
        } else {
          items.push(parseScalar(itemRaw));
          i++;
        }
      } else {
        break;
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
      if (!tok.raw.includes(':')) break;

      const colonIdx = tok.raw.indexOf(':');
      const key      = tok.raw.slice(0, colonIdx).trim();
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
