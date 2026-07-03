import type { JSONSchema } from '@matatbread/matbot-plugin-api';

export interface ParsedParam {
  name:      string;
  optional:  boolean;
  type?:     string;
}

export interface ParsedSignature {
  name?:       string;
  params:      ParsedParam[];
  returnType?: string;
  /** Raw parameter-list source (between the parens), types intact — e.g. `check: string, limit?: number`. */
  paramsText:  string;
  /** Raw function body including its braces — e.g. `{ return "hi"; }`. */
  body:        string;
}

/** Walk from the `(` at `open` to its matching `)`, skipping string literals; -1 if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  let str: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (str !== null) { if (c === str && s[i - 1] !== '\\') str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Walk from the `{` at `open` to its matching `}`, skipping string literals; -1 if unbalanced. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let str: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (str !== null) { if (c === str && s[i - 1] !== '\\') str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Find the function body's opening `{` at/after `from`: the first top-level `{` whose matching `}` is the
 *  final non-space char. A brace-bearing return type (e.g. `: { a: number }`) is skipped over — its `}`
 *  isn't at the end. Tracks `()[]<>` depth (so a `{` inside generics/params isn't mistaken for the body). */
function findBodyOpen(s: string, from: number): number {
  let end = s.length - 1;
  while (end >= 0 && /\s/.test(s[end] as string)) end--;
  if (end < 0 || s[end] !== '}') return -1;
  let depth = 0;
  let str: string | null = null;
  for (let i = from; i <= end; i++) {
    const c = s[i];
    if (str !== null) { if (c === str && s[i - 1] !== '\\') str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '=' && s[i + 1] === '>') { i++; continue; }
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') { if (depth > 0) depth--; }
    else if (c === '{' && depth === 0) {
      const close = matchBrace(s, i);
      if (close === end) return i;   // body: its `}` is the last char
      if (close === -1)  return -1;
      i = close;                     // a return-type object literal — skip past it
    }
  }
  return -1;
}

/** Split a parameter list on top-level commas, respecting nested brackets/generics/strings and `=>`. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let str: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str !== null) { if (c === str && s[i - 1] !== '\\') str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '=' && s[i + 1] === '>') { i++; continue; }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') { if (depth > 0) depth--; }
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

function parseParam(seg: string): ParsedParam | null {
  const s = seg.trim();
  if (s === '') return null;
  const m = s.match(/^(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*(\?)?\s*(?::\s*([\s\S]+?))?\s*(?:=\s*[\s\S]+)?$/);
  if (m === null) throw new Error(`can't parse parameter "${s}" — use simple named params, e.g. \`name: string\`.`);
  const type = m[3]?.trim();
  return {
    name:     m[1] as string,
    optional: m[2] === '?' || /=\s*\S/.test(s),
    ...(type !== undefined && type !== '' ? { type } : {}),
  };
}

/** Parse a method-shorthand function head (`name(params): ret { … }`). `name` is absent for a lambda. */
export function parseSignature(src: string): ParsedSignature {
  const head = src.match(/^\s*(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)?\s*\(/);
  if (head === null) throw new Error('not a function definition — expected `name(params) { … }`.');
  const name    = head[1];
  const openIdx = (head.index ?? 0) + head[0].length - 1;
  const closeIdx = matchParen(src, openIdx);
  if (closeIdx === -1) throw new Error('unbalanced parentheses in the parameter list.');

  const params = splitTopLevel(src.slice(openIdx + 1, closeIdx))
    .map(parseParam)
    .filter((p): p is ParsedParam => p !== null);
  // The body is the top-level `{…}` block that runs to the end; everything between `)` and it is the
  // (possibly brace-bearing, e.g. `{ a: number }`) return annotation. Can't just take the first `{` — an
  // object/inline return type has its own braces.
  const bodyOpen   = findBodyOpen(src, closeIdx + 1);
  const between    = bodyOpen >= 0 ? src.slice(closeIdx + 1, bodyOpen).trim() : '';
  const returnType = between.startsWith(':') ? between.slice(1).trim() : '';

  return {
    ...(name !== undefined ? { name } : {}),
    params,
    ...(returnType !== '' ? { returnType } : {}),
    paramsText: src.slice(openIdx + 1, closeIdx),
    body:       bodyOpen >= 0 ? src.slice(bodyOpen) : '{}',
  };
}

function tsTypeToSchema(type: string | undefined): JSONSchema {
  const t = type?.trim();
  if (t === 'string') return { type: 'string' };
  if (t === 'number' || t === 'bigint') return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t !== undefined && (/\[\]$/.test(t) || /^(readonly\s+)?(Array|ReadonlyArray)\s*</.test(t) || /^readonly\s*\[/.test(t))) return { type: 'array' };
  if (t !== undefined && (t.startsWith('{') || /^(Record|Map)\s*</.test(t))) return { type: 'object' };
  return {};
}

/** Object schema for a defined tool: one property per parameter, non-optional params required. */
export function paramsSchema(params: ParsedParam[]): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = tsTypeToSchema(p.type);
    if (!p.optional) required.push(p.name);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}
