/**
 * Minimal YAML parser for matbot config files.
 *
 * Supports:
 *   - Nested block mappings (key: value / key: followed by indented block)
 *   - Block sequences (- item)
 *   - Scalar types: string, number, boolean, null
 *   - Quoted strings (single and double)
 *   - Comments (# ...)
 *   - ${env:VAR_NAME} substitution in string values (expanded from env)
 *
 * Does NOT support anchors, aliases, multi-line scalars, or flow syntax.
 */

type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | YamlMap;
export type YamlMap   = { [key: string]: YamlValue };

interface Token {
  indent: number;
  raw:    string;    // original stripped content (no comment)
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

function parseScalar(raw: string, env: Record<string, string | undefined>): YamlScalar {
  // Expand ${env:VAR}
  const expanded = raw.replace(/\$\{env:([^}]+)\}/g, (_, name: string) =>
    env[name] ?? `\${env:${name}}`
  );

  // Quoted string
  if ((expanded.startsWith('"') && expanded.endsWith('"')) ||
      (expanded.startsWith("'") && expanded.endsWith("'"))) {
    return expanded.slice(1, -1);
  }

  if (expanded === 'null' || expanded === '~') return null;
  if (expanded === 'true')  return true;
  if (expanded === 'false') return false;

  const num = Number(expanded);
  if (!Number.isNaN(num) && expanded !== '') return num;

  return expanded;
}

function parse(tokens: Token[], pos: number, baseIndent: number, env: Record<string, string | undefined>): { value: YamlValue; next: number } {
  if (pos >= tokens.length) return { value: null, next: pos };

  const first = tokens[pos]!;

  // Sequence
  if (first.raw.startsWith('- ')) {
    const items: YamlValue[] = [];
    let i = pos;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (tok.indent < first.indent) break;
      if (tok.indent === first.indent && tok.raw.startsWith('- ')) {
        const itemRaw = tok.raw.slice(2).trim();
        if (itemRaw === '') {
          // Multi-line nested value
          const sub = parse(tokens, i + 1, tok.indent + 2, env);
          items.push(sub.value);
          i = sub.next;
        } else {
          items.push(parseScalar(itemRaw, env));
          i++;
        }
      } else {
        break;
      }
    }
    return { value: items, next: i };
  }

  // Mapping
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

      if (rest === '' || rest === '|' || rest === '>') {
        // Value is the next indented block
        const sub = parse(tokens, i + 1, tok.indent + 2, env);
        map[key]  = sub.value;
        i         = sub.next;
      } else {
        map[key] = parseScalar(rest, env);
        i++;
      }
    }
    return { value: map, next: i };
  }

  return { value: parseScalar(first.raw, env), next: pos + 1 };
}

export function parseYaml(
  text: string,
  env: Record<string, string | undefined> = {},
): YamlMap {
  const tokens = tokenize(text);
  if (tokens.length === 0) return {};
  const { value } = parse(tokens, 0, 0, env);
  return (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? value as YamlMap
    : {};
}
